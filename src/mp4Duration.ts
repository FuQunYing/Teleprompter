/**
 * 读取 / 修正 ISO-BMFF (mp4) 容器里的时长元数据。
 *
 * Safari 的 MediaRecorder 产出的是 fragmented MP4：媒体时间轴在 moof/tfdt/trun 里，
 * 而 moov 中 mvhd/tkhd/mdhd 的 duration 常常是错的（iOS 相册会显示成 20:25:22 之类
 * 的垃圾值）。这里按实际采样时间重算 duration 并原地回写。
 *
 * 只做「原地改写时长字段」，不改任何编码数据，因此不需要重写 box 尺寸。
 * 任何解析失败都原样返回原 blob，绝不损坏文件。
 */

export interface Mp4TrackInfo {
  kind: string // 'vide' | 'soun' | 其他
  trackId: number
  timescale: number
  storedDuration: number
  computedDuration: number
}

export interface Mp4Analysis {
  fragmented: boolean
  movieTimescale: number
  storedMovieDuration: number
  duration: number // 计算出的真实时长（秒）
  tracks: Mp4TrackInfo[]
}

export interface Mp4FixResult {
  blob: Blob
  analysis: Mp4Analysis
  changed: boolean
  /** 最终采用的时长（秒） */
  targetDuration: number
  /** 时长来源：'computed' 来自容器分片，'expected' 来自外部传入的实际录制时长 */
  source: 'computed' | 'expected' | 'none'
}

interface Box {
  type: string
  start: number
  size: number
  headerSize: number
  dataStart: number
  dataEnd: number
}

const FOURCC = (view: DataView, offset: number): string =>
  String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )

function readBoxes(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = []
  let p = start
  while (p + 8 <= end) {
    let size = view.getUint32(p)
    const type = FOURCC(view, p + 4)
    let headerSize = 8
    if (size === 1) {
      if (p + 16 > end) break
      size = Number(view.getBigUint64(p + 8))
      headerSize = 16
    } else if (size === 0) {
      size = end - p
    }
    if (size < headerSize || p + size > end) break
    boxes.push({ type, start: p, size, headerSize, dataStart: p + headerSize, dataEnd: p + size })
    p += size
  }
  return boxes
}

function findBox(boxes: Box[], type: string): Box | undefined {
  return boxes.find(b => b.type === type)
}

/** version/flags 占 4 字节 */
function versionOf(view: DataView, box: Box): number {
  return view.getUint8(box.dataStart)
}

function readUint(view: DataView, offset: number, bytes: number): number {
  if (bytes === 8) {
    const v = view.getBigUint64(offset)
    return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v)
  }
  return view.getUint32(offset)
}

// --- 各 box 的字段偏移 ---------------------------------------------------

// mvhd: version(1) flags(3) [creation] [modification] timescale(4) duration(4|8)
function mvhdTimescale(view: DataView, b: Box): number {
  const v = versionOf(view, b)
  return view.getUint32(b.dataStart + (v === 1 ? 20 : 12))
}
function mvhdDurationOffset(view: DataView, b: Box): { offset: number; bytes: number } {
  const v = versionOf(view, b)
  return v === 1
    ? { offset: b.dataStart + 24, bytes: 8 }
    : { offset: b.dataStart + 16, bytes: 4 }
}

// tkhd: version(1) flags(3) [creation] [modification] track_id(4) reserved(4) duration(4|8)
function tkhdTrackId(view: DataView, b: Box): number {
  const v = versionOf(view, b)
  return view.getUint32(b.dataStart + (v === 1 ? 20 : 12))
}
function tkhdDurationOffset(view: DataView, b: Box): { offset: number; bytes: number } {
  const v = versionOf(view, b)
  return v === 1
    ? { offset: b.dataStart + 28, bytes: 8 }
    : { offset: b.dataStart + 20, bytes: 4 }
}

// mdhd: version(1) flags(3) [creation] [modification] timescale(4) duration(4|8)
function mdhdTimescale(view: DataView, b: Box): number {
  const v = versionOf(view, b)
  return view.getUint32(b.dataStart + (v === 1 ? 20 : 12))
}
function mdhdDurationOffset(view: DataView, b: Box): { offset: number; bytes: number } {
  const v = versionOf(view, b)
  return v === 1
    ? { offset: b.dataStart + 24, bytes: 8 }
    : { offset: b.dataStart + 16, bytes: 4 }
}

// stts: version/flags(4) entry_count(4) [count(4) delta(4)]*
function readSttsTotal(view: DataView, b: Box): number {
  const count = view.getUint32(b.dataStart + 4)
  let total = 0
  let p = b.dataStart + 8
  for (let i = 0; i < count && p + 8 <= b.dataEnd; i++, p += 8) {
    total += view.getUint32(p) * view.getUint32(p + 4)
  }
  return total
}

// tfdt: version/flags(4) baseMediaDecodeTime(4|8)
function readTfdt(view: DataView, b: Box): number {
  const v = versionOf(view, b)
  return readUint(view, b.dataStart + 4, v === 1 ? 8 : 4)
}

// tfhd: version/flags(4) track_id(4) [optional fields]
function readTfhd(view: DataView, b: Box): { trackId: number; defaultSampleDuration: number } {
  const flags = (view.getUint32(b.dataStart) & 0xffffff)
  const trackId = view.getUint32(b.dataStart + 4)
  let p = b.dataStart + 8
  if (flags & 0x000001) p += 8
  if (flags & 0x000002) p += 4
  let defaultSampleDuration = 0
  if (flags & 0x000008) {
    defaultSampleDuration = view.getUint32(p)
    p += 4
  }
  if (flags & 0x000010) p += 4
  if (flags & 0x000020) p += 4
  return { trackId, defaultSampleDuration }
}

// trun: version/flags(4) sample_count(4) [data_offset(4)] [first_sample_flags(4)] [samples...]
function readTrunDuration(view: DataView, b: Box, fallback: number): number {
  const flags = view.getUint32(b.dataStart) & 0xffffff
  const sampleCount = view.getUint32(b.dataStart + 4)
  let p = b.dataStart + 8
  if (flags & 0x000001) p += 4
  if (flags & 0x000004) p += 4
  const perSampleBytes = ((flags & 0x000100) ? 4 : 0) + ((flags & 0x000200) ? 4 : 0) +
    ((flags & 0x000400) ? 4 : 0) + ((flags & 0x000800) ? 4 : 0)
  let total = 0
  let known = (flags & 0x000100) !== 0
  for (let i = 0; i < sampleCount; i++, p += perSampleBytes) {
    if (p + perSampleBytes > b.dataEnd) break
    if (flags & 0x000100) total += view.getUint32(p)
    else total += fallback
  }
  if (!known && fallback === 0) return 0
  return total
}

// --- 主分析 -------------------------------------------------------------

interface TrackAccum {
  trackId: number
  kind: string
  timescale: number
  mdhdBox: Box | null
  tkhdBox: Box | null
  sttsTotal: number
  fragStart: number
  fragEnd: number
  seenFragment: boolean
}

function analyse(buffer: ArrayBuffer): { analysis: Mp4Analysis; tracks: TrackAccum[]; moov: Box | undefined; movieTimescale: number } | null {
  const view = new DataView(buffer)
  const top = readBoxes(view, 0, buffer.byteLength)
  const moov = findBox(top, 'moov')
  if (!moov) return null

  const moovChildren = readBoxes(view, moov.dataStart, moov.dataEnd)
  const mvhd = findBox(moovChildren, 'mvhd')
  if (!mvhd) return null
  const movieTimescale = mvhdTimescale(view, mvhd)

  const traks = moovChildren.filter(b => b.type === 'trak')
  const tracks: TrackAccum[] = []

  for (const trak of traks) {
    const tk = readBoxes(view, trak.dataStart, trak.dataEnd)
    const tkhd = findBox(tk, 'tkhd')
    const mdia = findBox(tk, 'mdia')
    if (!tkhd || !mdia) continue
    const md = readBoxes(view, mdia.dataStart, mdia.dataEnd)
    const mdhd = findBox(md, 'mdhd')
    const hdlr = findBox(md, 'hdlr')
    const minf = findBox(md, 'minf')
    let kind = '????'
    if (hdlr) kind = FOURCC(view, hdlr.dataStart + 8)
    let sttsTotal = 0
    if (minf) {
      const stbl = findBox(readBoxes(view, minf.dataStart, minf.dataEnd), 'stbl')
      if (stbl) {
        const stts = findBox(readBoxes(view, stbl.dataStart, stbl.dataEnd), 'stts')
        if (stts) sttsTotal = readSttsTotal(view, stts)
      }
    }
    tracks.push({
      trackId: tkhdTrackId(view, tkhd),
      kind,
      timescale: mdhd ? mdhdTimescale(view, mdhd) : movieTimescale,
      mdhdBox: mdhd ?? null,
      tkhdBox: tkhd,
      sttsTotal,
      fragStart: Number.POSITIVE_INFINITY,
      fragEnd: 0,
      seenFragment: false,
    })
  }

  // 收集 fragment（moof）里的采样时长
  const byTrackId = new Map(tracks.map(t => [t.trackId, t]))
  for (const moof of top.filter(b => b.type === 'moof')) {
    const mf = readBoxes(view, moof.dataStart, moof.dataEnd)
    for (const traf of mf.filter(b => b.type === 'traf')) {
      const tf = readBoxes(view, traf.dataStart, traf.dataEnd)
      const tfhd = findBox(tf, 'tfhd')
      const tfdt = findBox(tf, 'tfdt')
      if (!tfhd) continue
      const { trackId, defaultSampleDuration } = readTfhd(view, tfhd)
      const acc = byTrackId.get(trackId)
      const base = tfdt ? readTfdt(view, tfdt) : 0
      let dur = 0
      for (const trun of tf.filter(b => b.type === 'trun')) {
        dur += readTrunDuration(view, trun, defaultSampleDuration)
      }
      if (!acc) continue
      acc.seenFragment = true
      acc.fragStart = Math.min(acc.fragStart, base)
      acc.fragEnd = Math.max(acc.fragEnd, base + dur)
    }
  }

  const fragmented = tracks.some(t => t.seenFragment)

  const outTracks: Mp4TrackInfo[] = tracks.map(t => {
    const stored = t.mdhdBox
      ? readUint(view, mdhdDurationOffset(view, t.mdhdBox).offset, mdhdDurationOffset(view, t.mdhdBox).bytes)
      : 0
    let computed: number
    if (t.seenFragment) {
      computed = Math.max(0, t.fragEnd - (Number.isFinite(t.fragStart) ? t.fragStart : 0))
    } else {
      computed = t.sttsTotal
    }
    return {
      kind: t.kind,
      trackId: t.trackId,
      timescale: t.timescale,
      storedDuration: stored,
      computedDuration: computed,
    }
  })

  const duration = outTracks.reduce((max, t) => {
    const seconds = t.computedDuration / (t.timescale || 1)
    return Math.max(max, seconds)
  }, 0)

  return {
    analysis: {
      fragmented,
      movieTimescale,
      storedMovieDuration: readUint(view, mvhdDurationOffset(view, mvhd).offset, mvhdDurationOffset(view, mvhd).bytes),
      duration,
      tracks: outTracks,
    },
    tracks,
    moov,
    movieTimescale,
  }
}

/**
 * 修正 mp4 的时长元数据。解析失败或不是 mp4 时原样返回。
 *
 * @param expectedDuration 实际录制时长（秒），用于容器内时间戳不可信时兜底
 */
export async function fixMp4Duration(input: Blob, expectedDuration?: number): Promise<Mp4FixResult> {
  const emptyAnalysis: Mp4Analysis = {
    fragmented: false,
    movieTimescale: 1000,
    storedMovieDuration: 0,
    duration: 0,
    tracks: [],
  }
  const fallback: Mp4FixResult = {
    blob: input,
    analysis: emptyAnalysis,
    changed: false,
    targetDuration: 0,
    source: 'none',
  }

  if (!/mp4/i.test(input.type)) return fallback

  let buffer: ArrayBuffer
  try {
    buffer = await input.arrayBuffer()
  } catch {
    return fallback
  }

  let parsed: ReturnType<typeof analyse>
  try {
    parsed = analyse(buffer)
  } catch {
    return fallback
  }
  if (!parsed) return fallback

  const { analysis, tracks, moov, movieTimescale } = parsed
  if (!moov) return { blob: input, analysis, changed: false, targetDuration: 0, source: 'none' }

  // 容器内算出的时长 vs 实际录制时长
  const computed = analysis.duration
  const expected = typeof expectedDuration === 'number' && expectedDuration > 0 ? expectedDuration : 0
  // 超过这个上限就认为容器里的时间戳本身是垃圾值
  const sanityCap = Math.max(3600, expected * 3)

  let target = computed
  let source: Mp4FixResult['source'] = 'computed'
  if (!(computed > 0) || computed > sanityCap) {
    if (expected > 0) {
      target = expected
      source = 'expected'
    } else {
      return { blob: input, analysis, changed: false, targetDuration: 0, source: 'none' }
    }
  }
  if (!(target > 0)) return { blob: input, analysis, changed: false, targetDuration: 0, source: 'none' }

  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  let changed = false

  const writeDuration = (offset: number, bytes_: number, value: number) => {
    if (value < 0 || !Number.isFinite(value)) return
    const rounded = Math.round(value)
    // 已经正确就不动，避免无意义的改写
    if (readUint(view, offset, bytes_) === rounded) return
    if (bytes_ === 4) {
      if (rounded > 0xffffffff) return
      view.setUint32(offset, rounded)
    } else {
      if (rounded > Number.MAX_SAFE_INTEGER) return
      view.setBigUint64(offset, BigInt(rounded))
    }
    changed = true
  }

  // 各轨按比例缩放，保持轨道之间的相对长度
  const trackSeconds = analysis.tracks.map(t => t.computedDuration / (t.timescale || 1))
  const maxSeconds = trackSeconds.reduce((m, s) => Math.max(m, s), 0)
  const scale = maxSeconds > 0 ? target / maxSeconds : 0

  for (const t of tracks) {
    const info = analysis.tracks.find(x => x.trackId === t.trackId)
    if (!info) continue

    let mediaDuration: number
    if (scale > 0) {
      const seconds = trackSeconds[analysis.tracks.indexOf(info)] ?? 0
      mediaDuration = Math.round(seconds * scale * (info.timescale || 1))
    } else {
      mediaDuration = Math.round(target * (info.timescale || 1))
    }
    if (!mediaDuration) continue

    if (t.mdhdBox) {
      const { offset, bytes: n } = mdhdDurationOffset(view, t.mdhdBox)
      writeDuration(offset, n, mediaDuration)
    }
    if (t.tkhdBox) {
      const { offset, bytes: n } = tkhdDurationOffset(view, t.tkhdBox)
      const inMovieTimescale = (mediaDuration / (info.timescale || 1)) * movieTimescale
      writeDuration(offset, n, Math.round(inMovieTimescale))
    }
  }

  // mvhd.duration：影片时长
  const mvhd = findBox(readBoxes(view, moov.dataStart, moov.dataEnd), 'mvhd')
  if (mvhd) {
    const { offset, bytes: n } = mvhdDurationOffset(view, mvhd)
    writeDuration(offset, n, Math.round(target * movieTimescale))
  }

  if (!changed) return { blob: input, analysis, changed: false, targetDuration: target, source }

  return {
    blob: new Blob([bytes], { type: input.type }),
    analysis,
    changed: true,
    targetDuration: target,
    source,
  }
}
