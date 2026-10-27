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
 * 转换本身不改动任何编码数据：只是把样本表从分片搬到 moov，mdat 里仍是原来的字节。
 */

export interface ProgressiveTrack {
  kind: string
  samples: number
  duration: number // 秒
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

interface Sample {
  duration: number
  data: Uint8Array
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
      let p = tfhd.dataStart + 8
      let baseDataOffset: number | null = null
      if (flags & 0x000001) {
        baseDataOffset = Number(view.getBigUint64(p))
        p += 8
      }
      if (flags & 0x000002) p += 4
      let defaultDuration = 0
      if (flags & 0x000008) {
        defaultDuration = view.getUint32(p)
        p += 4
      }
      if (flags & 0x000010) p += 4
      if (flags & 0x000020) p += 4
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
        if (f & 0x000004) q += 4
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
          if (f & 0x000400) q += 4
          if (f & 0x000800) q += 4
          const finalSize = size ?? 0
          track.samples.push({
            duration: duration ?? defaultDuration,
            data: bytes.subarray(off, off + finalSize),
          })
          off += finalSize
        }
      }
    }
  }

  const used = [...tracks.values()].filter(t => t.samples.length > 0)
  if (!used.length) return empty

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
      stblParts.push(stts, stsc, stsz, stco)
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
        else mdiaParts.push(slice(k))
      }
      const newMdia = makeBox('mdia', ...mdiaParts)

      parts.push(makeBox('trak', slice(t.tkhd), newMdia))
    }
    // mvhd 原样保留（时长已在前面修好），不放 mvex —— progressive 文件没有 mvex
    return makeBox('moov', slice(mvhd), ...parts)
  }

  const ftyp = top.find(b => b.type === 'ftyp')
  let moov = buildMoov(0)
  // chunk 偏移是相对文件的绝对位置，需要加上 moov 之后的位置
  moov = buildMoov((ftyp?.size ?? 0) + moov.length + 8)

  // 用一个大头 + 各个分片直接构造 Blob，避免再复制一份完整数据
  const mdatBoxHeader = new Uint8Array(8)
  new DataView(mdatBoxHeader.buffer).setUint32(0, mdatPayloadLength + 8)
  mdatBoxHeader.set(new TextEncoder().encode('mdat'), 4)

  const parts: BlobPart[] = []
  if (ftyp) parts.push(slice(ftyp) as BlobPart)
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
    })),
  }
}
