// fragmented mp4 → progressive（普通）mp4 转换。
// 目的：WebKit（Safari / iOS Safari）对 fragmented mp4 的时长计算会把音视频两条轨
// 的时长相加，导致时长翻倍；转成 progressive 后走 stts/stsz 这条正确的路径。
//
// 用法: node scripts/fragmented-to-progressive.mjs <输入.mp4> <输出.mp4> [真实时长秒]
import { readFileSync, writeFileSync } from 'node:fs'

const [, , inFile, outFile, expectedArg] = process.argv
const src = new Uint8Array(readFileSync(inFile))
const dv = new DataView(src.buffer, src.byteOffset, src.byteLength)
const enc = new TextEncoder()

function boxes(start, end) {
  const out = []
  let p = start
  while (p + 8 <= end) {
    const size = dv.getUint32(p)
    const type = String.fromCharCode(...src.slice(p + 4, p + 8))
    if (size < 8 || p + size > end) break
    out.push({ type, start: p, size, dataStart: p + 8 })
    p += size
  }
  return out
}
function concat(list) {
  const total = list.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const a of list) { out.set(a, p); p += a.length }
  return out
}
function u32(n) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n); return a }
function box(type, ...payloads) {
  const body = concat(payloads)
  const head = new Uint8Array(8)
  new DataView(head.buffer).setUint32(0, body.length + 8)
  head.set(enc.encode(type), 4)
  return concat([head, body])
}
const slice = b => src.slice(b.start, b.start + b.size)
const fourcc = off => String.fromCharCode(...src.slice(off, off + 4))

const top = boxes(0, src.length)
const ftypBox = top.find(b => b.type === 'ftyp')
const moovBox = top.find(b => b.type === 'moov')
const moovChildren = boxes(moovBox.dataStart, moovBox.start + moovBox.size)
const mvhdBox = moovChildren.find(b => b.type === 'mvhd')

// ---- 收集每条轨的样本 ----
const trackMeta = new Map()
for (const trak of moovChildren.filter(b => b.type === 'trak')) {
  const tk = boxes(trak.dataStart, trak.start + trak.size)
  const tkhd = tk.find(b => b.type === 'tkhd')
  const mdia = tk.find(b => b.type === 'mdia')
  const md = mdia ? boxes(mdia.dataStart, mdia.start + mdia.size) : []
  const mdhd = md.find(b => b.type === 'mdhd')
  const hdlr = md.find(b => b.type === 'hdlr')
  const minf = md.find(b => b.type === 'minf')
  const kind = hdlr ? fourcc(hdlr.dataStart + 8) : '?'
  const trackId = dv.getUint32(tkhd.dataStart + (dv.getUint8(tkhd.dataStart) === 1 ? 20 : 12))
  const mdhdV = dv.getUint8(mdhd.dataStart)
  const stbl = minf ? boxes(minf.dataStart, minf.start + minf.size).find(b => b.type === 'stbl') : null
  const stblChildren = stbl ? boxes(stbl.dataStart, stbl.start + stbl.size) : []
  const stsd = stblChildren.find(b => b.type === 'stsd')
  trackMeta.set(trackId, {
    kind, trackId, tkhd, mdhd, hdlr, minf, stsd, mdia,
    timescale: dv.getUint32(mdhd.dataStart + (mdhdV === 1 ? 20 : 12)),
    samples: [],
  })
}

// 从分片里取样本
for (const moof of top.filter(b => b.type === 'moof')) {
  for (const traf of boxes(moof.dataStart, moof.start + moof.size).filter(b => b.type === 'traf')) {
    const tf = boxes(traf.dataStart, traf.start + traf.size)
    const tfhdBox = tf.find(b => b.type === 'tfhd')
    const flags = dv.getUint32(tfhdBox.dataStart) & 0xffffff
    const trackId = dv.getUint32(tfhdBox.dataStart + 4)
    let p = tfhdBox.dataStart + 8
    let baseDataOffset = null
    if (flags & 0x000001) { baseDataOffset = Number(dv.getBigUint64(p)); p += 8 }
    if (flags & 0x000002) p += 4
    let defaultDuration = 0
    if (flags & 0x000008) { defaultDuration = dv.getUint32(p); p += 4 }
    if (flags & 0x000010) p += 4
    if (flags & 0x000020) p += 4
    const base = baseDataOffset ?? moof.start
    const meta = trackMeta.get(trackId)
    if (!meta) continue

    for (const t of tf.filter(x => x.type === 'trun')) {
      const f = dv.getUint32(t.dataStart) & 0xffffff
      const count = dv.getUint32(t.dataStart + 4)
      let q = t.dataStart + 8
      let dataOffset = null
      if (f & 0x000001) { dataOffset = dv.getInt32(q); q += 4 }
      if (f & 0x000004) q += 4
      let off = base + (dataOffset ?? 0)
      for (let i = 0; i < count; i++) {
        const s = {}
        if (f & 0x000100) { s.duration = dv.getUint32(q); q += 4 }
        if (f & 0x000200) { s.size = dv.getUint32(q); q += 4 }
        if (f & 0x000400) { s.flags = dv.getUint32(q); q += 4 }
        if (f & 0x000800) { s.cts = dv.getInt32(q); q += 4 }
        s.duration = s.duration ?? defaultDuration
        s.data = src.slice(off, off + (s.size ?? 0))
        off += s.size ?? 0
        meta.samples.push(s)
      }
    }
  }
}

for (const m of trackMeta.values()) {
  const total = m.samples.reduce((a, s) => a + (s.duration ?? 0), 0)
  console.log(`轨 ${m.kind}: 样本=${m.samples.length} 时长=${(total / m.timescale).toFixed(3)}s`)
}

// ---- 生成 progressive 文件 ----
const tracks = [...trackMeta.values()]
const movieTimescale = dv.getUint32(mvhdBox.dataStart + (dv.getUint8(mvhdBox.dataStart) === 1 ? 20 : 12))
const target = expectedArg ? Number(expectedArg) : 0

// mdat：每条轨的数据连续排布
const mdatChunks = []
let mdatCursor = 0
for (const t of tracks) {
  t.chunkOffset = null // 稍后填
  for (const s of t.samples) {
    if (t.chunkOffset === null) t.chunkOffset = mdatCursor
    mdatChunks.push(s.data)
    mdatCursor += s.data.length
  }
}
const mdatPayload = concat(mdatChunks)
const mdatPayloadStart = 0 // 相对整个文件，稍后加 moov 长度

// 先算 moov 的长度（stco 需要绝对的 chunk 偏移）
function buildMoov(chunkOffsetBase) {
  const parts = []
  for (const t of tracks) {
    // stts：把相同 duration 的样本合并成一条
    const runs = []
    for (const s of t.samples) {
      const last = runs[runs.length - 1]
      if (last && last.delta === s.duration) last.count++
      else runs.push({ count: 1, delta: s.duration })
    }
    const stts = box('stts', u32(0), u32(runs.length), ...runs.map(r => concat([u32(r.count), u32(r.delta)])))
    const stsz = box('stsz', u32(0), u32(0), u32(t.samples.length),
      ...t.samples.map(s => u32(s.data.length)))
    const stsc = box('stsc', u32(0), u32(1), u32(1), u32(t.samples.length), u32(1))
    const stco = box('stco', u32(0), u32(1), u32(chunkOffsetBase + t.chunkOffset))

    const stblChildren = []
    if (t.stsd) stblChildren.push(slice(t.stsd))
    stblChildren.push(stts, stsc, stsz, stco)
    const stbl = box('stbl', ...stblChildren)

    const minfChildren = []
    const minfKids = boxes(t.minf.dataStart, t.minf.start + t.minf.size)
    for (const k of minfKids) {
      if (k.type === 'stbl') continue
      if (k.type === 'dinf') { minfChildren.push(slice(k)); continue }
      minfChildren.push(slice(k))
    }
    minfChildren.push(stbl)
    const newMinf = box('minf', ...minfChildren)

    const mdiaParts = []
    for (const k of boxes(t.mdia.dataStart, t.mdia.start + t.mdia.size)) {
      if (k.type === 'minf') mdiaParts.push(newMinf)
      else mdiaParts.push(slice(k))
    }
    const newMdia = box('mdia', ...mdiaParts)

    const newTrak = box('trak', slice(t.tkhd), newMdia)
    parts.push(newTrak)
  }
  const mvhd = slice(mvhdBox)
  return box('moov', mvhd, ...parts)
}

// 先用占位偏移算一次长度，再回填
let moov = buildMoov(0)
const chunkOffsetBase = ftypBox.size + moov.length + 8
moov = buildMoov(chunkOffsetBase)

const file = concat([slice(ftypBox), moov, box('mdat', mdatPayload)])
writeFileSync(outFile, file)
console.log('已写出', outFile, `mdat=${mdatPayload.length} moov=${moov.length}`)
