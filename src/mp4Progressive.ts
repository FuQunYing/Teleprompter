/**
 * fragmented mp4 → progressive（普通）mp4 转换。
 *
 * 为什么需要：
 * MediaRecorder 产出的是 fragmented mp4（样本在 moof/trun 里描述，mdat 只存数据）。
 * WebKit（Safari / iOS Safari / 所有 WebKit 浏览器）对 fragmented mp4 的时长计算是
 * **把音视频两条轨的时长相加**，于是 10.5 秒的片子会被报成 21 秒，进度条和剪辑
 * 软件里全是错的（AVFoundation / Chrome 的 demuxer 是对的）。
 *
 * 转成 progressive mp4 后，播放器走 stts/stsz 这条标准路径，时长就正确了。
 * 转换不改编码数据，只重写容器，让剪辑软件能随机取帧：
 * - 按码流里的 IDR 写关键帧表（stss）。没有这张表时，剪映会把 P 帧当关键帧解，时间轴是黑的。
 * - 帧时长保持原样：iOS 网页录像是可变帧率，每帧时长就是它的采集时间，改成等长会音画不同步。
 * - ftyp 改成普通 mp4，去掉 hlsf（分片直播）标记。
 * - 轨标志标成「在成片里」，mvhd/tkhd/mdhd 的时长改成样本时长之和。
 */

export interface ProgressiveTrack {
  kind: string
  samples: number
  duration: number // 秒
  /** 视频轨里扫出来的关键帧数。音频轨没有这个字段。 */
  syncSamples?: number
}

export interface ProgressiveResult {
  blob: Blob
  changed: boolean
  tracks: ProgressiveTrack[]
}

interface Box {
  type: string
  start: number
  size: number
  dataStart: number
}

const FOURCC = (view: DataView, offset: number): string =>
  String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )

function readBoxes(view: DataView, start: number, end: number): Box[] {
  const out: Box[] = []
  let p = start
  while (p + 8 <= end) {
    const size = view.getUint32(p)
    const type = FOURCC(view, p + 4)
    if (size < 8 || p + size > end) break
    out.push({ type, start: p, size, dataStart: p + 8 })
    p += size
  }
  return out
}

function concat(list: Uint8Array[]): Uint8Array {
  const total = list.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const a of list) {
    out.set(a, p)
    p += a.length
  }
  return out
}

function u32(n: number): Uint8Array {
  const a = new Uint8Array(4)
  new DataView(a.buffer).setUint32(0, n)
  return a
}

function makeBox(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const body = concat(payloads)
  const head = new Uint8Array(8)
  const dv = new DataView(head.buffer)
  dv.setUint32(0, body.length + 8)
  head.set(new TextEncoder().encode(type), 4)
  return concat([head, body])
}

/** 普通渐进式 mp4，不带 hlsf / iso5 这类分片品牌。 */
function makeFtyp(): Uint8Array {
  const enc = new TextEncoder()
  return makeBox(
    'ftyp',
    enc.encode('isom'),
    u32(0x200),
    enc.encode('isom'),
    enc.encode('iso2'),
    enc.encode('avc1'),
    enc.encode('mp41'),
  )
}

function writeUint(dv: DataView, offset: number, bytes: 4 | 8, value: number) {
  const v = Math.max(0, Math.round(value))
  if (bytes === 8) dv.setBigUint64(offset, BigInt(Math.min(v, Number.MAX_SAFE_INTEGER)))
  else if (v <= 0xffffffff) dv.setUint32(offset, v)
}

/** 打开 track_enabled | track_in_movie | track_in_preview，并写上影片时基下的时长。 */
function finishTkhd(box: Uint8Array, movieDuration: number): Uint8Array {
  const out = box.slice()
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const version = out[8]
  const raw = dv.getUint32(8)
  dv.setUint32(8, (raw & 0xff000000) | ((raw | 0x7) & 0x00ffffff))
  const wide = version === 1
  writeUint(dv, 8 + (wide ? 28 : 20), wide ? 8 : 4, movieDuration)
  return out
}

/** mvhd / mdhd 的 duration 字段位置相同。 */
function finishDuration(box: Uint8Array, duration: number): Uint8Array {
  const out = box.slice()
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const wide = out[8] === 1
  writeUint(dv, 8 + (wide ? 24 : 16), wide ? 8 : 4, duration)
  return out
}

function readTrexDefaults(view: DataView, moovChildren: Box[]): Map<number, TrexDefault> {
  const out = new Map<number, TrexDefault>()
  const mvex = moovChildren.find(b => b.type === 'mvex')
  if (!mvex) return out
  for (const trex of readBoxes(view, mvex.dataStart, mvex.start + mvex.size).filter(b => b.type === 'trex')) {
    out.set(view.getUint32(trex.dataStart + 4), {
      duration: view.getUint32(trex.dataStart + 12),
      size: view.getUint32(trex.dataStart + 16),
      flags: view.getUint32(trex.dataStart + 20),
    })
  }
  return out
}

function avcNalLengthSize(stsd: Box | null, view: DataView, bytes: Uint8Array): number | null {
  if (!stsd) return null
  const entryCount = view.getUint32(stsd.dataStart + 4)
  let p = stsd.dataStart + 8
  const end = stsd.start + stsd.size
  for (let i = 0; i < entryCount && p + 8 <= end; i++) {
    const size = view.getUint32(p)
    if (size < 8 || p + size > end) break
    const type = FOURCC(view, p + 4)
    if (type === 'avc1' || type === 'avc3') {
      const children = readBoxes(view, p + 8 + 78, p + size)
      const avcC = children.find(b => b.type === 'avcC')
      if (avcC && avcC.start + avcC.size >= avcC.dataStart + 5) {
        return (bytes[avcC.dataStart + 4] & 3) + 1
      }
      return 4
    }
    p += size
  }
  return null
}

/** 样本能按长度前缀拆完、且含 IDR（NAL type 5）时返回 true/false，拆不开返回 null。 */
function sampleHasIdr(data: Uint8Array, nalLen: number): boolean | null {
  if (nalLen < 1 || nalLen > 4 || data.length < nalLen + 1) return null
  let r = 0
  let idr = false
  while (r + nalLen <= data.length) {
    let len = 0
    for (let i = 0; i < nalLen; i++) len = (len << 8) | data[r + i]
    if (len < 1 || r + nalLen + len > data.length) return null
    if ((data[r + nalLen] & 0x1f) === 5) idr = true
    r += nalLen + len
  }
  return r === data.length ? idr : null
}

function markVideoSync(track: TrackInfo, view: DataView, bytes: Uint8Array) {
  const nalLen = avcNalLengthSize(track.stsd, view, bytes) ?? 4
  const idr: (boolean | null)[] = track.samples.map(s => sampleHasIdr(s.data, nalLen))
  const parsed = idr.filter(v => v !== null).length
  const idrCount = idr.filter(v => v === true).length
  if (parsed === track.samples.length && idrCount > 0) {
    track.samples.forEach((s, i) => { s.sync = idr[i] === true })
  }
  if (!track.samples.some(s => s.sync) && track.samples.length) track.samples[0].sync = true
}

interface Sample {
  duration: number
  data: Uint8Array
  /** 来自分片标志。视频轨随后会按 IDR 改写。 */
  sync: boolean
}

interface TrexDefault {
  duration: number
  size: number
  flags: number
}

interface TrackInfo {
  trackId: number
  kind: string
  timescale: number
  tkhd: Box
  mdia: Box
  minf: Box
  stsd: Box | null
  samples: Sample[]
  /** 在 mdat 里的起始位置（组装时填） */
  chunkOffset: number
}

/**
 * 把 fragmented mp4 转成 progressive mp4。输入不是 fragmented 时原样返回。
 */
export async function toProgressiveMp4(input: Blob): Promise<ProgressiveResult> {
  const empty: ProgressiveResult = { blob: input, changed: false, tracks: [] }
  if (!/mp4/i.test(input.type)) return empty

  let buffer: ArrayBuffer
  try {
    buffer = await input.arrayBuffer()
  } catch {
    return empty
  }

  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const slice = (b: Box) => bytes.subarray(b.start, b.start + b.size)

  const top = readBoxes(view, 0, bytes.length)
  const moovBox = top.find(b => b.type === 'moov')
  if (!moovBox) return empty
  if (!top.some(b => b.type === 'moof')) return empty // 已经是 progressive

  const moovChildren = readBoxes(view, moovBox.dataStart, moovBox.start + moovBox.size)
  const mvhd = moovChildren.find(b => b.type === 'mvhd')
  if (!mvhd) return empty
  const mvhdVersion = view.getUint8(mvhd.dataStart)
  const movieTimescale = view.getUint32(mvhd.dataStart + (mvhdVersion === 1 ? 20 : 12)) || 1000
  const trexDefaults = readTrexDefaults(view, moovChildren)

  const tracks = new Map<number, TrackInfo>()
  for (const trak of moovChildren.filter(b => b.type === 'trak')) {
    const tk = readBoxes(view, trak.dataStart, trak.start + trak.size)
    const tkhd = tk.find(b => b.type === 'tkhd')
    const mdia = tk.find(b => b.type === 'mdia')
    if (!tkhd || !mdia) continue
    const md = readBoxes(view, mdia.dataStart, mdia.start + mdia.size)
    const mdhd = md.find(b => b.type === 'mdhd')
    const hdlr = md.find(b => b.type === 'hdlr')
    const minf = md.find(b => b.type === 'minf')
    if (!mdhd || !minf) continue
    const mdhdV = view.getUint8(mdhd.dataStart)
    const stbl = readBoxes(view, minf.dataStart, minf.start + minf.size).find(b => b.type === 'stbl')
    const stsd = stbl
      ? readBoxes(view, stbl.dataStart, stbl.start + stbl.size).find(b => b.type === 'stsd') ?? null
      : null
    const tkhdV = view.getUint8(tkhd.dataStart)
    tracks.set(view.getUint32(tkhd.dataStart + (tkhdV === 1 ? 20 : 12)), {
      trackId: view.getUint32(tkhd.dataStart + (tkhdV === 1 ? 20 : 12)),
      kind: hdlr ? FOURCC(view, hdlr.dataStart + 8) : '????',
      timescale: view.getUint32(mdhd.dataStart + (mdhdV === 1 ? 20 : 12)),
      tkhd,
      mdia,
      minf,
      stsd,
      samples: [],
      chunkOffset: 0,
    })
  }
  if (!tracks.size) return empty

  // ---- 从分片里收集样本 ----
  for (const moof of top.filter(b => b.type === 'moof')) {
    for (const traf of readBoxes(view, moof.dataStart, moof.start + moof.size).filter(b => b.type === 'traf')) {
      const tf = readBoxes(view, traf.dataStart, traf.start + traf.size)
      const tfhd = tf.find(b => b.type === 'tfhd')
      if (!tfhd) continue
      const flags = view.getUint32(tfhd.dataStart) & 0xffffff
      const trackId = view.getUint32(tfhd.dataStart + 4)
      const trex = trexDefaults.get(trackId)
      let p = tfhd.dataStart + 8
      let baseDataOffset: number | null = null
      if (flags & 0x000001) {
        baseDataOffset = Number(view.getBigUint64(p))
        p += 8
      }
      if (flags & 0x000002) p += 4
      let defaultDuration = trex?.duration ?? 0
      if (flags & 0x000008) {
        defaultDuration = view.getUint32(p)
        p += 4
      }
      let defaultSize = trex?.size ?? 0
      if (flags & 0x000010) {
        defaultSize = view.getUint32(p)
        p += 4
      }
      // 0x00010000 = sample_is_non_sync_sample。Safari 的默认值经常把非首帧都标成非关键帧。
      let defaultFlags = trex?.flags ?? 0
      if (flags & 0x000020) {
        defaultFlags = view.getUint32(p)
        p += 4
      }
      const base = baseDataOffset ?? moof.start
      const track = tracks.get(trackId)
      if (!track) continue

      for (const trun of tf.filter(b => b.type === 'trun')) {
        const f = view.getUint32(trun.dataStart) & 0xffffff
        const count = view.getUint32(trun.dataStart + 4)
        let q = trun.dataStart + 8
        let dataOffset: number | null = null
        if (f & 0x000001) {
          dataOffset = view.getInt32(q)
          q += 4
        }
        let firstFlags: number | null = null
        if (f & 0x000004) {
          firstFlags = view.getUint32(q)
          q += 4
        }
        let off = base + (dataOffset ?? 0)
        for (let i = 0; i < count; i++) {
          let duration: number | undefined
          let size: number | undefined
          if (f & 0x000100) {
            duration = view.getUint32(q)
            q += 4
          }
          if (f & 0x000200) {
            size = view.getUint32(q)
            q += 4
          }
          let sampleFlags = defaultFlags
          if (f & 0x000400) {
            sampleFlags = view.getUint32(q)
            q += 4
          } else if (i === 0 && firstFlags !== null) {
            sampleFlags = firstFlags
          }
          if (f & 0x000800) q += 4
          const finalSize = size ?? defaultSize
          const start = off < 0 ? 0 : off
          const end = Math.min(bytes.length, start + Math.max(0, finalSize))
          track.samples.push({
            duration: duration ?? defaultDuration,
            data: bytes.subarray(start, end),
            sync: (sampleFlags & 0x00010000) === 0,
          })
          off += finalSize
        }
      }
    }
  }

  const used = [...tracks.values()].filter(t => t.samples.length > 0)
  if (!used.length) return empty

  for (const t of used) {
    if (t.kind === 'vide') markVideoSync(t, view, bytes)
    else t.samples.forEach(s => { s.sync = true })
  }

  const mediaDuration = (t: TrackInfo) => t.samples.reduce((sum, s) => sum + s.duration, 0)
  const movieDurationOf = (t: TrackInfo) => {
    if (t.timescale <= 0) return 0
    return Math.round(mediaDuration(t) / t.timescale * movieTimescale)
  }
  const movieDuration = used.reduce((max, t) => Math.max(max, movieDurationOf(t)), 0)

  // ---- 组装 mdat：每条轨的数据连续排布 ----
  // 注意：不把样本数据拼成一个大数组（那样会多占一份内存），
  // 而是直接用分片数组交给 Blob 构造器。
  const mdatChunks: Uint8Array[] = []
  let cursor = 0
  for (const t of used) {
    t.chunkOffset = cursor
    for (const s of t.samples) {
      mdatChunks.push(s.data)
      cursor += s.data.length
    }
  }
  const mdatPayloadLength = cursor

  // ---- 组装 moov ----
  const buildMoov = (chunkOffsetBase: number): Uint8Array => {
    const parts: Uint8Array[] = []
    for (const t of used) {
      // stts：把时长相同的样本合并成一条
      const runs: { count: number; delta: number }[] = []
      for (const s of t.samples) {
        const last = runs[runs.length - 1]
        if (last && last.delta === s.duration) last.count++
        else runs.push({ count: 1, delta: s.duration })
      }
      const stts = makeBox(
        'stts',
        u32(0),
        u32(runs.length),
        ...runs.map(r => concat([u32(r.count), u32(r.delta)])),
      )
      // 全部都是关键帧时按规范不写 stss。有 P 帧才列出 IDR 的样本序号（从 1 开始）。
      const syncNums = t.samples.every(s => s.sync)
        ? []
        : t.samples.flatMap((s, i) => s.sync ? [i + 1] : [])
      const stss = syncNums.length
        ? makeBox('stss', u32(0), u32(syncNums.length), ...syncNums.map(n => u32(n)))
        : null
      const stsz = makeBox(
        'stsz',
        u32(0),
        u32(0),
        u32(t.samples.length),
        ...t.samples.map(s => u32(s.data.length)),
      )
      // 每条轨的样本都在同一个 chunk 里
      const stsc = makeBox('stsc', u32(0), u32(1), u32(1), u32(t.samples.length), u32(1))
      const stco = makeBox('stco', u32(0), u32(1), u32(chunkOffsetBase + t.chunkOffset))

      const stblParts: Uint8Array[] = []
      if (t.stsd) stblParts.push(slice(t.stsd))
      stblParts.push(stts)
      if (stss) stblParts.push(stss)
      stblParts.push(stsc, stsz, stco)
      const stbl = makeBox('stbl', ...stblParts)

      const minfParts: Uint8Array[] = []
      for (const k of readBoxes(view, t.minf.dataStart, t.minf.start + t.minf.size)) {
        if (k.type === 'stbl') continue
        minfParts.push(slice(k))
      }
      minfParts.push(stbl)
      const newMinf = makeBox('minf', ...minfParts)

      const mdiaParts: Uint8Array[] = []
      for (const k of readBoxes(view, t.mdia.dataStart, t.mdia.start + t.mdia.size)) {
        if (k.type === 'minf') mdiaParts.push(newMinf)
        else if (k.type === 'mdhd') mdiaParts.push(finishDuration(slice(k), mediaDuration(t)))
        else mdiaParts.push(slice(k))
      }
      const newMdia = makeBox('mdia', ...mdiaParts)

      parts.push(makeBox('trak', finishTkhd(slice(t.tkhd), movieDurationOf(t)), newMdia))
    }
    // 不放 mvex —— progressive 文件没有分片
    return makeBox('moov', finishDuration(slice(mvhd), movieDuration), ...parts)
  }

  const ftyp = makeFtyp()
  let moov = buildMoov(0)
  // chunk 偏移是相对文件的绝对位置，需要加上 moov 之后的位置
  moov = buildMoov(ftyp.length + moov.length + 8)

  // 用一个大头 + 各个分片直接构造 Blob，避免再复制一份完整数据
  const mdatBoxHeader = new Uint8Array(8)
  new DataView(mdatBoxHeader.buffer).setUint32(0, mdatPayloadLength + 8)
  mdatBoxHeader.set(new TextEncoder().encode('mdat'), 4)

  const parts: BlobPart[] = []
  parts.push(ftyp as BlobPart)
  parts.push(moov as BlobPart)
  parts.push(mdatBoxHeader as BlobPart)
  for (const c of mdatChunks) parts.push(c as BlobPart)

  return {
    blob: new Blob(parts, { type: input.type }),
    changed: true,
    tracks: used.map(t => ({
      kind: t.kind,
      samples: t.samples.length,
      duration: t.samples.reduce((a, s) => a + s.duration, 0) / (t.timescale || 1),
      syncSamples: t.kind === 'vide' ? t.samples.filter(s => s.sync).length : undefined,
    })),
  }
}
