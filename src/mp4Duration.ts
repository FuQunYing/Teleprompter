/**
 * 读取 / 修正 ISO-BMFF (mp4) 的时间轴。
 *
 * 背景：Safari 的 MediaRecorder 产出的 mp4 里，时间轴是坏的 ——
 *  · moov 里 mvhd/tkhd/mdhd 的 duration 是垃圾值（相册里显示成 20:25:22 之类）
 *  · fragmented 模式下 moof 里 tfdt 组成的分片时间轴也不对（音频样本挤在开头、
 *    画面只剩一帧被硬拉长）
 *
 * 播放器的时长是按「样本时间轴」算的，只改 moov 头部完全没用。
 * 所以这里做两件事：
 *  1. 按每个分片里样本的实际时长，重建 tfdt 链（消除挤压/空洞）
 *  2. 把每条轨的样本时长整体缩放，使该轨的总时长等于真实录制时长（消除变速）
 *  3. 最后把 moov 里的 mvhd/tkhd/mdhd duration 同步过来
 *
 * 只改写定长数值字段，不改任何编码数据与 box 尺寸，因此不会破坏文件。
 * 任何解析失败都原样返回原 blob。
 */

export interface Mp4TrackInfo {
  kind: string // 'vide' | 'soun' | 其他
  trackId: number
  timescale: number
  /** moov 里原本标注的时长（媒体时基） */
  storedDuration: number
  /** 按样本时间轴算出的时长（秒） */
  timelineDuration: number
  /** 样本数量 */
  sampleCount: number
  /** 是否做了缩放 */
  scaled: boolean
}

export interface Mp4Analysis {
  fragmented: boolean
  movieTimescale: number
  storedMovieDuration: number
  /** 按样本时间轴算出的整体时长（秒） */
  duration: number
  tracks: Mp4TrackInfo[]
}

export interface Mp4FixResult {
  blob: Blob
  analysis: Mp4Analysis
  changed: boolean
  /** 最终采用的时长（秒） */
  targetDuration: number
  /** 时长来源：'expected' 来自外部传入的真实录制时长，'timeline' 来自容器样本时间轴 */
  source: 'expected' | 'timeline' | 'none'
  /** 人类可读的诊断信息 */
  report: string
}

interface Box {
  type: string
  start: number
  size: number
  headerSize: number
  dataStart: number
  dataEnd: number
}

/** 一个可写回的时长字段 */
interface Field {
  offset: number
  bytes: 4 | 8
  value: number
}

/** 一个分片（moof + traf） */
interface Fragment {
  trackId: number
  /** tfdt.baseMediaDecodeTime 的字段位置 */
  tfdt: Field | null
  /** 每个样本的 duration 字段（trun 里有 per-sample duration 时） */
  sampleDurations: Field[]
  /** trun 没有 per-sample duration 时，用 tfhd 的 default_sample_duration */
  defaultDuration: Field | null
  /** 本分片的样本数 */
  sampleCount: number
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

// --- 各 box 的字段偏移（dataStart 指向 payload 第一个字节 = version）--------

// mvhd: version(1) flags(3) [creation] [modification] timescale(4) duration(4|8)
function mvhdTimescale(view: DataView, b: Box): number {
  const v = versionOf(view, b)
  return view.getUint32(b.dataStart + (v === 1 ? 20 : 12))
}
function mvhdDurationOffset(view: DataView, b: Box): { offset: number; bytes: 4 | 8 } {
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
function tkhdDurationOffset(view: DataView, b: Box): { offset: number; bytes: 4 | 8 } {
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
function mdhdDurationOffset(view: DataView, b: Box): { offset: number; bytes: 4 | 8 } {
  const v = versionOf(view, b)
  return v === 1
    ? { offset: b.dataStart + 24, bytes: 8 }
    : { offset: b.dataStart + 16, bytes: 4 }
}

// hdlr: version/flags(4) pre_defined(4) handler_type(4)
function hdlrKind(view: DataView, b: Box): string {
  return FOURCC(view, b.dataStart + 8)
}

interface SttsEntry {
  /** count 字段 */
  count: number
  /** delta 字段 */
  deltaOffset: number
  delta: number
}

function readStts(view: DataView, b: Box): SttsEntry[] {
  const count = view.getUint32(b.dataStart + 4)
  const entries: SttsEntry[] = []
  let p = b.dataStart + 8
  for (let i = 0; i < count && p + 8 <= b.dataEnd; i++, p += 8) {
    entries.push({ count: view.getUint32(p), deltaOffset: p + 4, delta: view.getUint32(p + 4) })
  }
  return entries
}

// tfdt: version/flags(4) baseMediaDecodeTime(4|8)
function readTfdt(view: DataView, b: Box): Field {
  const v = versionOf(view, b)
  return {
    offset: b.dataStart + 4,
    bytes: v === 1 ? 8 : 4,
    value: readUint(view, b.dataStart + 4, v === 1 ? 8 : 4),
  }
}

// tfhd: version/flags(4) track_id(4) [optional fields]
function readTfhd(view: DataView, b: Box): { trackId: number; defaultDuration: Field | null } {
  const flags = view.getUint32(b.dataStart) & 0xffffff
  const trackId = view.getUint32(b.dataStart + 4)
  let p = b.dataStart + 8
  if (flags & 0x000001) p += 8
  if (flags & 0x000002) p += 4
  let defaultDuration: Field | null = null
  if (flags & 0x000008) {
    defaultDuration = { offset: p, bytes: 4, value: view.getUint32(p) }
    p += 4
  }
  return { trackId, defaultDuration }
}

// trun: version/flags(4) sample_count(4) [data_offset(4)] [first_sample_flags(4)] [samples...]
function readTrun(view: DataView, b: Box): { count: number; durations: Field[] } {
  const flags = view.getUint32(b.dataStart) & 0xffffff
  const count = view.getUint32(b.dataStart + 4)
  let p = b.dataStart + 8
  if (flags & 0x000001) p += 4
  if (flags & 0x000004) p += 4
  const hasDuration = (flags & 0x000100) !== 0
  const perSampleBytes =
    (hasDuration ? 4 : 0) +
    ((flags & 0x000200) ? 4 : 0) +
    ((flags & 0x000400) ? 4 : 0) +
    ((flags & 0x000800) ? 4 : 0)

  const durations: Field[] = []
  for (let i = 0; i < count; i++, p += perSampleBytes) {
    if (p + perSampleBytes > b.dataEnd) break
    if (hasDuration) durations.push({ offset: p, bytes: 4, value: view.getUint32(p) })
  }
  return { count, durations }
}

// elst: version/flags(4) entry_count(4) entry[ segment_duration(4|8) media_time(4|8) rate(4) ]
// segment_duration 的单位是影片时基（mvhd.timescale），所有 entry 之和就是「呈现时长」，
// 播放器会用它来覆盖 mvhd.duration —— 这是 Safari 时长翻倍的常见来源。
interface ElstEntry {
  segmentDurationOffset: number
  segmentDurationBytes: 4 | 8
  segmentDuration: number
  mediaTime: number
}

function readElst(view: DataView, b: Box): ElstEntry[] {
  const v = versionOf(view, b)
  const count = view.getUint32(b.dataStart + 4)
  const entries: ElstEntry[] = []
  const size = v === 1 ? 20 : 12
  let p = b.dataStart + 8
  for (let i = 0; i < count && p + size <= b.dataEnd; i++, p += size) {
    const bytes = (v === 1 ? 8 : 4) as 4 | 8
    const segmentDuration = readUint(view, p, bytes)
    const mediaTime = v === 1
      ? Number(view.getBigInt64(p + 8))
      : view.getInt32(p + 4)
    entries.push({
      segmentDurationOffset: p,
      segmentDurationBytes: bytes,
      segmentDuration,
      mediaTime,
    })
  }
  return entries
}


interface TrackParse {
  trackId: number
  kind: string
  timescale: number
  mdhd: Box | null
  tkhd: Box | null
  stts: SttsEntry[]
  fragments: Fragment[]
  elst: ElstEntry[]
}

interface ParseResult {
  analysis: Mp4Analysis
  tracks: TrackParse[]
  moov: Box
  movieTimescale: number
}

function parse(buffer: ArrayBuffer): ParseResult | null {
  const view = new DataView(buffer)
  const top = readBoxes(view, 0, buffer.byteLength)
  const moov = findBox(top, 'moov')
  if (!moov) return null

  const moovChildren = readBoxes(view, moov.dataStart, moov.dataEnd)
  const mvhd = findBox(moovChildren, 'mvhd')
  if (!mvhd) return null
  const movieTimescale = mvhdTimescale(view, mvhd)

  const tracks: TrackParse[] = []

  for (const trak of moovChildren.filter(b => b.type === 'trak')) {
    const tk = readBoxes(view, trak.dataStart, trak.dataEnd)
    const tkhd = findBox(tk, 'tkhd')
    const mdia = findBox(tk, 'mdia')
    if (!tkhd || !mdia) continue
    const md = readBoxes(view, mdia.dataStart, mdia.dataEnd)
    const mdhd = findBox(md, 'mdhd')
    const hdlr = findBox(md, 'hdlr')
    const minf = findBox(md, 'minf')

    const edts = findBox(tk, 'edts')
    let elst: ElstEntry[] = []
    if (edts) {
      const elstBox = findBox(readBoxes(view, edts.dataStart, edts.dataEnd), 'elst')
      if (elstBox) elst = readElst(view, elstBox)
    }

    let stts: SttsEntry[] = []
    if (minf) {
      const stbl = findBox(readBoxes(view, minf.dataStart, minf.dataEnd), 'stbl')
      if (stbl) {
        const sttsBox = findBox(readBoxes(view, stbl.dataStart, stbl.dataEnd), 'stts')
        if (sttsBox) stts = readStts(view, sttsBox)
      }
    }

    tracks.push({
      trackId: tkhdTrackId(view, tkhd),
      kind: hdlr ? hdlrKind(view, hdlr) : '????',
      timescale: mdhd ? mdhdTimescale(view, mdhd) : movieTimescale,
      mdhd: mdhd ?? null,
      tkhd: tkhd ?? null,
      elst,
      stts,
      fragments: [],
    })
  }

  const byTrackId = new Map(tracks.map(t => [t.trackId, t]))

  // 分片（moof）里的样本信息
  for (const moof of top.filter(b => b.type === 'moof')) {
    const mf = readBoxes(view, moof.dataStart, moof.dataEnd)
    for (const traf of mf.filter(b => b.type === 'traf')) {
      const tf = readBoxes(view, traf.dataStart, traf.dataEnd)
      const tfhdBox = findBox(tf, 'tfhd')
      if (!tfhdBox) continue
      const { trackId, defaultDuration } = readTfhd(view, tfhdBox)
      const tfdtBox = findBox(tf, 'tfdt')

      const sampleDurations: Field[] = []
      let sampleCount = 0
      for (const trun of tf.filter(b => b.type === 'trun')) {
        const t = readTrun(view, trun)
        sampleCount += t.count
        sampleDurations.push(...t.durations)
      }

      const acc = byTrackId.get(trackId)
      if (!acc) continue
      acc.fragments.push({
        trackId,
        tfdt: tfdtBox ? readTfdt(view, tfdtBox) : null,
        sampleDurations,
        defaultDuration,
        sampleCount,
      })
    }
  }

  const fragmented = tracks.some(t => t.fragments.length > 0)

  const infos: Mp4TrackInfo[] = tracks.map(t => {
    let timeline = 0
    let sampleCount = 0

    if (t.fragments.length) {
      for (const f of t.fragments) {
        let fragDuration = 0
        for (const d of f.sampleDurations) fragDuration += d.value
        if (!f.sampleDurations.length && f.defaultDuration) {
          fragDuration = f.defaultDuration.value * f.sampleCount
        }
        timeline += fragDuration
        sampleCount += f.sampleCount
      }
      // 分片里没有每样本时长时，时间轴只能从 tfdt 链推算
      if (timeline === 0) {
        const bases = t.fragments.map(f => f.tfdt?.value).filter((v): v is number => v !== undefined)
        if (bases.length) timeline = Math.max(...bases) - Math.min(...bases)
      }
    } else {
      for (const e of t.stts) {
        timeline += e.count * e.delta
        sampleCount += e.count
      }
    }

    const stored = t.mdhd
      ? readUint(view, mdhdDurationOffset(view, t.mdhd).offset, mdhdDurationOffset(view, t.mdhd).bytes)
      : 0

    return {
      kind: t.kind,
      trackId: t.trackId,
      timescale: t.timescale,
      storedDuration: stored,
      timelineDuration: timeline / (t.timescale || 1),
      sampleCount,
      scaled: false,
    }
  })

  const duration = infos.reduce((max, t) => Math.max(max, t.timelineDuration), 0)

  return {
    analysis: {
      fragmented,
      movieTimescale,
      storedMovieDuration: readUint(view, mvhdDurationOffset(view, mvhd).offset, mvhdDurationOffset(view, mvhd).bytes),
      duration,
      tracks: infos,
    },
    tracks,
    moov,
    movieTimescale,
  }
}

/**
 * 修正 mp4 的时间轴。
 *
 * @param expectedDuration 真实录制时长（秒）。传入后每条轨都会被缩放到这个长度，
 *                         消除容器时间轴偏长/偏短导致的变速与空洞。
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
    report: '非 mp4 或解析失败，原样返回',
  }

  if (!/mp4/i.test(input.type)) return fallback

  let buffer: ArrayBuffer
  try {
    buffer = await input.arrayBuffer()
  } catch {
    return fallback
  }

  let parsed: ParseResult | null
  try {
    parsed = parse(buffer)
  } catch {
    return fallback
  }
  if (!parsed) return fallback

  const { analysis, tracks, moov, movieTimescale } = parsed

  const expected = typeof expectedDuration === 'number' && expectedDuration > 0 ? expectedDuration : 0
  // 时间轴长到这个程度就认为容器数据本身不可信
  const sanityCap = Math.max(3600, expected * 3)

  // 真实录制时长是基准；容器自己的时间轴只用来兜底
  // （容器的样本时间轴可能整体偏长/偏短，直接采信会导致播放变速）
  let target: number
  let source: Mp4FixResult['source']
  if (expected > 0) {
    target = expected
    source = 'expected'
  } else if (analysis.duration > 0 && analysis.duration <= sanityCap) {
    target = analysis.duration
    source = 'timeline'
  } else {
    return { ...fallback, blob: input, analysis, report: '容器没有可用的时间信息' }
  }
  if (!(target > 0)) return { ...fallback, blob: input, analysis }

  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  let changed = false

  const writeField = (field: Field, value: number) => {
    const rounded = Math.round(value)
    if (!Number.isFinite(rounded) || rounded < 0) return
    if (readUint(view, field.offset, field.bytes) === rounded) return
    if (field.bytes === 4) {
      if (rounded > 0xffffffff) return
      view.setUint32(field.offset, rounded)
    } else {
      if (rounded > Number.MAX_SAFE_INTEGER) return
      view.setBigUint64(field.offset, BigInt(rounded))
    }
    changed = true
    field.value = rounded
  }

  const reportLines: string[] = []

  for (const t of tracks) {
    const info = analysis.tracks.find(x => x.trackId === t.trackId)
    if (!info) continue

    // 1) 把这条轨的样本时长整体缩放到目标时长
    const currentTimeline = info.timelineDuration
    let scale = 1
    if (currentTimeline > 0 && target > 0) {
      scale = target / currentTimeline
    }
    // 缩放幅度过大说明数据不可信，宁可不动
    const scaleUsable = scale >= 0.5 && scale <= 2
    // 样本时间轴通常是对的（差个百分之一来自录制启停），
    // 只有偏差超过 10% 才认为时间轴本身坏了，需要整体缩放
    const needScale = Math.abs(scale - 1) > 0.1

    if (t.fragments.length) {
      const totalSamples = t.fragments.reduce((s, f) => s + f.sampleCount, 0)

      // 每个分片的时长：优先用每样本时长，其次用 tfhd 的默认值，
      // 都没有的话只能从相邻分片的 tfdt 差值推断
      const fragDurations: (number | null)[] = t.fragments.map((f, i) => {
        let d = 0
        for (const s of f.sampleDurations) d += s.value
        if (!f.sampleDurations.length && f.defaultDuration) d = f.defaultDuration.value * f.sampleCount
        if (d > 0) return d
        // 从下一个分片的 tfdt 推断
        const next = t.fragments[i + 1]
        if (next?.tfdt && f.tfdt) {
          const delta = next.tfdt.value - f.tfdt.value
          if (delta > 0) return delta
        }
        return null
      })
      const allKnown = fragDurations.every(d => d !== null && d > 0)

      if (allKnown) {
        // 1) 缩放样本时长
        if (scaleUsable && needScale) {
          for (const f of t.fragments) {
            for (const d of f.sampleDurations) writeField(d, d.value * scale)
            if (!f.sampleDurations.length && f.defaultDuration) {
              writeField(f.defaultDuration, f.defaultDuration.value * scale)
            }
          }
          info.scaled = true
        }

        // 2) 重建 tfdt 链：每个分片的起始 = 前面所有分片样本时长之和
        let cursor = t.fragments[0]?.tfdt?.value ?? 0
        for (let i = 0; i < t.fragments.length; i++) {
          const f = t.fragments[i]
          if (f.tfdt) writeField(f.tfdt, cursor)
          cursor += fragDurations[i] ?? 0
        }
      } else {
        // 分片没有可用的时长信息：时间轴只能靠 tfdt，
        // 这时不能重建链（会抹掉唯一的时间信息），只能整体缩放 tfdt
        if (scaleUsable && needScale) {
          for (const f of t.fragments) {
            if (f.tfdt) writeField(f.tfdt, f.tfdt.value * scale)
          }
          info.scaled = true
        }
      }

      reportLines.push(
        `${info.kind}: timescale=${info.timescale} 样本=${totalSamples} 时间轴=${currentTimeline.toFixed(2)}s → ${(target).toFixed(2)}s${info.scaled ? '（已缩放）' : ''}${allKnown ? '' : '（按 tfdt 缩放）'}`,
      )
    } else if (t.stts.length) {
      // 非 fragmented：缩放 stts 的 delta
      if (scaleUsable && needScale) {
        for (const e of t.stts) {
          writeField({ offset: e.deltaOffset, bytes: 4, value: e.delta }, e.delta * scale)
        }
        info.scaled = true
      }
      reportLines.push(
        `${info.kind}: timescale=${info.timescale} 样本=${info.sampleCount} 时间轴=${currentTimeline.toFixed(2)}s → ${(target).toFixed(2)}s${info.scaled ? '（已缩放）' : ''}`,
      )
    }

    // 4) 编辑列表：呈现时长的另一个来源，播放器优先用它
    if (t.elst.length) {
      const elstTotal = t.elst.reduce((s, e) => s + e.segmentDuration, 0)
      const targetUnits = Math.round(target * movieTimescale)
      if (elstTotal > 0 && targetUnits > 0) {
        const elstScale = targetUnits / elstTotal
        if (elstScale >= 0.5 && elstScale <= 2) {
          let written = 0
          t.elst.forEach((e, i) => {
            const isLast = i === t.elst.length - 1
            const value = isLast
              ? targetUnits - written
              : Math.round(e.segmentDuration * elstScale)
            writeField(
              { offset: e.segmentDurationOffset, bytes: e.segmentDurationBytes, value: 0 },
              value,
            )
            written += value
          })
          info.scaled = true
          reportLines.push(
            `${info.kind}: elst ${elstTotal} → ${targetUnits}(影片时基 ${movieTimescale})`,
          )
        }
      }
    }

    // 3) 同步 moov 里的时长
    if (t.mdhd) {
      const { offset, bytes: n } = mdhdDurationOffset(view, t.mdhd)
      writeField({ offset, bytes: n, value: 0 }, Math.round(target * info.timescale))
    }
    if (t.tkhd) {
      const { offset, bytes: n } = tkhdDurationOffset(view, t.tkhd)
      writeField({ offset, bytes: n, value: 0 }, Math.round(target * movieTimescale))
    }
  }

  const mvhd = findBox(readBoxes(view, moov.dataStart, moov.dataEnd), 'mvhd')
  if (mvhd) {
    const { offset, bytes: n } = mvhdDurationOffset(view, mvhd)
    writeField({ offset, bytes: n, value: 0 }, Math.round(target * movieTimescale))
  }

  const report = reportLines.join('；')

  if (!changed) {
    return { blob: input, analysis, changed: false, targetDuration: target, source, report }
  }

  return {
    blob: new Blob([bytes], { type: input.type }),
    analysis,
    changed: true,
    targetDuration: target,
    source,
    report,
  }
}

// --- 诊断导出 ---------------------------------------------------------------

/**
 * 把 mp4 的 box 结构完整导成文本，方便排查「时长不对」这类问题。
 * 只打印 box 结构与关键字段，不打印 mdat 里的编码数据。
 */
export async function dumpMp4Structure(input: Blob): Promise<string> {
  let buffer: ArrayBuffer
  try {
    buffer = await input.arrayBuffer()
  } catch {
    return '读取失败'
  }

  const view = new DataView(buffer)
  const lines: string[] = []
  lines.push(`文件大小 ${(input.size / 1024 / 1024).toFixed(2)} MB, type=${input.type}`)

  const describe = (b: Box): string => {
    try {
      switch (b.type) {
        case 'mvhd': {
          const v = versionOf(view, b)
          const ts = mvhdTimescale(view, b)
          const off = mvhdDurationOffset(view, b)
          return `timescale=${ts} duration=${readUint(view, off.offset, off.bytes)} (${(readUint(view, off.offset, off.bytes) / ts).toFixed(3)}s) v${v}`
        }
        case 'tkhd': {
          const v = versionOf(view, b)
          const off = tkhdDurationOffset(view, b)
          const flags = view.getUint32(b.dataStart) & 0xffffff
          return `track_id=${tkhdTrackId(view, b)} duration=${readUint(view, off.offset, off.bytes)} v${v} flags=0x${flags.toString(16)}`
        }
        case 'mdhd': {
          const v = versionOf(view, b)
          const ts = mdhdTimescale(view, b)
          const off = mdhdDurationOffset(view, b)
          return `timescale=${ts} duration=${readUint(view, off.offset, off.bytes)} (${(readUint(view, off.offset, off.bytes) / ts).toFixed(3)}s) v${v}`
        }
        case 'hdlr':
          return `handler=${hdlrKind(view, b)}`
        case 'elst': {
          const entries = readElst(view, b)
          const total = entries.reduce((s, e) => s + e.segmentDuration, 0)
          return `${entries.length} 个 entry, segment_duration 合计=${total}, 明细=[${entries.map(e => `${e.segmentDuration}@${e.mediaTime}`).join(', ')}]`
        }
        case 'stts': {
          const entries = readStts(view, b)
          const total = entries.reduce((s, e) => s + e.count * e.delta, 0)
          return `${entries.length} 条, 合计=${total}, 明细=[${entries.map(e => `${e.count}x${e.delta}`).join(', ')}]`
        }
        case 'tfhd': {
          const { trackId, defaultDuration } = readTfhd(view, b)
          const flags = view.getUint32(b.dataStart) & 0xffffff
          return `track_id=${trackId} flags=0x${flags.toString(16)} default_sample_duration=${defaultDuration?.value ?? '-'}`
        }
        case 'tfdt': {
          const f = readTfdt(view, b)
          return `baseMediaDecodeTime=${f.value}`
        }
        case 'trun': {
          const t = readTrun(view, b)
          const sum = t.durations.reduce((s, d) => s + d.value, 0)
          const flags = view.getUint32(b.dataStart) & 0xffffff
          let dataOffset = '-'
          if (flags & 0x000001) dataOffset = String(view.getInt32(b.dataStart + 8))
          return `flags=0x${flags.toString(16)} sample_count=${t.count} data_offset=${dataOffset} 有每样本时长=${t.durations.length} 合计=${sum}`
        }
        case 'trex': {
          const trackId = view.getUint32(b.dataStart + 4)
          const descIdx = view.getUint32(b.dataStart + 8)
          const dur = view.getUint32(b.dataStart + 12)
          const size = view.getUint32(b.dataStart + 16)
          return `track_id=${trackId} default_sample_description_index=${descIdx} default_sample_duration=${dur} default_sample_size=${size}`
        }
        case 'stsd':
          return `entries=${view.getUint32(b.dataStart + 4)}`
        default:
          return ''
      }
    } catch {
      return '(解析出错)'
    }
  }

  const walk = (b: Box, depth: number) => {
    const indent = '  '.repeat(depth)
    const info = describe(b)
    lines.push(`${indent}${b.type} (${b.size} 字节)${info ? '  ' + info : ''}`)
    if (b.type === 'mdat') return // 编码数据不打印
    const children = readBoxes(view, b.dataStart, b.dataEnd)
    for (const c of children) walk(c, depth + 1)
  }

  for (const b of readBoxes(view, 0, buffer.byteLength)) walk(b, 0)

  return lines.join('\n')
}
