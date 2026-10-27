// 把「单个 moof 里含多个 traf」的 fragmented mp4 重写成「每个 traf 一个 moof+mdat」
// 的布局 —— 这正是 Safari 在 recorder.start(timeslice) 下的原生输出形态。
//
// 用法: node scripts/split-moof.mjs <输入.mp4> <输出.mp4>
import { readFileSync, writeFileSync } from 'node:fs'

const [, , inFile, outFile] = process.argv
if (!inFile || !outFile) {
  console.error('用法: node scripts/split-moof.mjs <输入> <输出>')
  process.exit(1)
}

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

const top = boxes(0, src.length)
const ftypBox = top.find(b => b.type === 'ftyp')
const moovBox = top.find(b => b.type === 'moov')

// ---- 解析每个 traf 的每个 trun，取出样本数据 ----
const runs = [] // { trackId, tfhdBytes, trunFlags, samples:[{duration,size,flags,cts}], data }
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
    let defaultSampleDuration = 0
    if (flags & 0x000008) { defaultSampleDuration = dv.getUint32(p); p += 4 }
    if (flags & 0x000010) p += 4
    if (flags & 0x000020) p += 4
    const base = baseDataOffset ?? moof.start

    for (const t of tf.filter(x => x.type === 'trun')) {
      const f = dv.getUint32(t.dataStart) & 0xffffff
      const count = dv.getUint32(t.dataStart + 4)
      let q = t.dataStart + 8
      let dataOffset = null
      if (f & 0x000001) { dataOffset = dv.getInt32(q); q += 4 }
      let firstSampleFlags = 0
      if (f & 0x000004) { firstSampleFlags = dv.getUint32(q); q += 4 }
      const samples = []
      for (let i = 0; i < count; i++) {
        const s = {}
        if (f & 0x000100) { s.duration = dv.getUint32(q); q += 4 }
        if (f & 0x000200) { s.size = dv.getUint32(q); q += 4 }
        if (f & 0x000400) { s.flags = dv.getUint32(q); q += 4 }
        if (f & 0x000800) { s.cts = dv.getInt32(q); q += 4 }
        samples.push(s)
      }
      const start = base + (dataOffset ?? 0)
      let off = start
      const data = []
      for (const s of samples) {
        data.push(src.slice(off, off + (s.size ?? 0)))
        off += s.size ?? 0
      }
      runs.push({
        trackId,
        tfhdBytes: src.slice(tfhdBox.start, tfhdBox.start + tfhdBox.size),
        defaultSampleDuration,
        trunFlags: f,
        firstSampleFlags,
        samples,
        data: concat(data),
      })
    }
  }
}

console.log('分片段数:', runs.length)

// ---- 重建：每段一个 moof + 一个 mdat，tfdt 用累计时长 ----
// 片段的时间基来自对应轨的 mdhd
const moovChildren = boxes(moovBox.dataStart, moovBox.start + moovBox.size)
const trackTimescale = new Map()
for (const trak of moovChildren.filter(b => b.type === 'trak')) {
  const tk = boxes(trak.dataStart, trak.start + trak.size)
  const tkhd = tk.find(b => b.type === 'tkhd')
  const mdia = tk.find(b => b.type === 'mdia')
  const md = mdia ? boxes(mdia.dataStart, mdia.start + mdia.size) : []
  const mdhd = md.find(b => b.type === 'mdhd')
  const v = dv.getUint8(mdhd.dataStart)
  const trackId = dv.getUint32(tkhd.dataStart + (dv.getUint8(tkhd.dataStart) === 1 ? 20 : 12))
  trackTimescale.set(trackId, dv.getUint32(mdhd.dataStart + (v === 1 ? 20 : 12)))
}

const cursorByTrack = new Map()
const pieces = []
let seq = 1
for (const run of runs) {
  const ts = trackTimescale.get(run.trackId) ?? 1
  let cursor = cursorByTrack.get(run.trackId) ?? 0

  // 这一段的时长：优先用每样本时长，否则用 tfhd 的 default_sample_duration
  let dur = 0
  const hasDur = run.samples.some(s => s.duration !== undefined)
  if (hasDur) {
    for (const s of run.samples) dur += s.duration ?? 0
  } else {
    dur = run.defaultSampleDuration * run.samples.length
  }

  const trunParts = [u32(run.trunFlags), u32(run.samples.length)]
  // data_offset 先占位（稍后回填），假设 moof 头 + tfhd + tfdt + trun 头
  const trunHeaderLen = 8 + 4 + 4 // trun header + sample_count + data_offset
  const trunPayloadLen = run.samples.reduce((a, s) =>
    a + ((run.trunFlags & 0x100) ? 4 : 0) + ((run.trunFlags & 0x200) ? 4 : 0) +
       ((run.trunFlags & 0x400) ? 4 : 0) + ((run.trunFlags & 0x800) ? 4 : 0), 0)
  const tfhdLen = run.tfhdBytes.length
  const tfdt = box('tfdt', u32(0), u32(cursor))
  const dataOffsetPos = trunParts.length
  trunParts.push(u32(0)) // data_offset 占位
  if (run.trunFlags & 0x000004) trunParts.push(u32(run.firstSampleFlags))
  for (const s of run.samples) {
    if (run.trunFlags & 0x100) trunParts.push(u32(s.duration ?? 0))
    if (run.trunFlags & 0x200) trunParts.push(u32(s.size ?? 0))
    if (run.trunFlags & 0x400) trunParts.push(u32(s.flags ?? 0))
    if (run.trunFlags & 0x800) trunParts.push(u32(s.cts ?? 0))
  }
  const trunBox = box('trun', ...trunParts)
  const moof = box('moof', box('mfhd', u32(0), u32(seq++)),
    box('traf', run.tfhdBytes, tfdt, trunBox))
  const mdat = box('mdat', run.data)
  pieces.push({ moof, mdat, tfhdLen, tfdtLen: tfdt.length, trunHeaderLen, dataOffsetPos })
  cursorByTrack.set(run.trackId, cursor + dur)
}

// ---- 回填 data_offset（相对 moof 起点）并拼接 ----
function findBoxes(bytes, start, end) {
  const out = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = start
  while (p + 8 <= end) {
    const size = view.getUint32(p)
    const type = String.fromCharCode(...bytes.slice(p + 4, p + 8))
    if (size < 8 || p + size > end) break
    out.push({ type, start: p, size, dataStart: p + 8 })
    p += size
  }
  return out
}

const out = []
let offset = 0
for (const p of pieces) {
  const moofStart = offset
  const mdatPayloadStart = moofStart + p.moof.length + 8
  const dataOffset = mdatPayloadStart - moofStart

  // 在构建好的 moof 里定位 trun 的 data_offset 字段
  const moofChildren = findBoxes(p.moof, 8, p.moof.length)
  const traf = moofChildren.find(b => b.type === 'traf')
  const trafChildren = findBoxes(p.moof, traf.dataStart, traf.start + traf.size)
  const trun = trafChildren.find(b => b.type === 'trun')
  const trunFlags = new DataView(p.moof.buffer, p.moof.byteOffset, p.moof.byteLength)
    .getUint32(trun.dataStart) & 0xffffff
  if (trunFlags & 0x000001) {
    new DataView(p.moof.buffer, p.moof.byteOffset, p.moof.byteLength)
      .setUint32(trun.dataStart + 8, dataOffset)
  }

  out.push(p.moof, p.mdat)
  offset += p.moof.length + p.mdat.length
}

const ftyp = src.slice(ftypBox.start, ftypBox.start + ftypBox.size)
const moov = src.slice(moovBox.start, moovBox.start + moovBox.size)
writeFileSync(outFile, concat([ftyp, moov, ...out]))
console.log('已写出', outFile)
