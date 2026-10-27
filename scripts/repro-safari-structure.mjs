// 把 Chrome 产出的 fragmented mp4 重构成 iOS Safari MediaRecorder 的结构：
//   ftyp + moov + 单个 moof(2 个 traf) + 单个 mdat
// 用来在本地（afinfo = AVFoundation，和 iOS 相册同一引擎）复现「时长翻倍」问题。
//
// 用法：node scripts/repro-safari-structure.mjs <输入.mp4> <输出.mp4> [--safari-mvhd]
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const inFile = args[0]
const outFile = args[1]
const safari = args.includes('--safari')
const patchSafariMvhd = safari || args.includes('--safari-mvhd')
const zeroDur = safari || args.includes('--zero-dur')
const ts600 = args.includes('--ts600')
const videoTs600 = safari || args.includes('--video-ts600')
if (!inFile || !outFile) {
  console.error('用法: node scripts/repro-safari-structure.mjs <输入> <输出>')
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
  const dv2 = new DataView(head.buffer)
  dv2.setUint32(0, body.length + 8)
  head.set(enc.encode(type), 4)
  return concat([head, body])
}

const top = boxes(0, src.length)
const ftypBox = top.find(b => b.type === 'ftyp')
const moovBox = top.find(b => b.type === 'moov')
const moofs = top.filter(b => b.type === 'moof')

// ---- 解析：按文件顺序收集所有样本，以及每个 (轨, trun) 对应的全局区间 ----
const globalSamples = [] // { trackId, size, data }
const runs = [] // { trackId, globalStart, count, flags, tfhdPayload }

for (const moof of moofs) {
  for (const traf of boxes(moof.dataStart, moof.dataStart + moof.size).filter(b => b.type === 'traf')) {
    const tf = boxes(traf.dataStart, traf.dataStart + traf.size)
    const tfhdBox = tf.find(x => x.type === 'tfhd')
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
      if (f & 0x000004) q += 4
      const globalStart = globalSamples.length
      let off = base + (dataOffset ?? 0)
      for (let i = 0; i < count; i++) {
        const s = {}
        if (f & 0x000100) { s.duration = dv.getUint32(q); q += 4 }
        if (f & 0x000200) { s.size = dv.getUint32(q); q += 4 }
        if (f & 0x000400) { s.flags = dv.getUint32(q); q += 4 }
        if (f & 0x000800) { s.cts = dv.getInt32(q); q += 4 }
        s.data = src.slice(off, off + (s.size ?? 0))
        off += s.size ?? 0
        globalSamples.push({ trackId, ...s })
      }
      runs.push({ trackId, globalStart, count, flags: f })
    }
  }
}

const trackIds = [...new Set(globalSamples.map(s => s.trackId))].sort((a, b) => a - b)
const videoScale = 600 / 30000 // Safari 的视频轨时基是 600
console.log('轨道:', trackIds.map(id => {
  const n = globalSamples.filter(s => s.trackId === id).length
  return `#${id} 样本=${n}`
}).join(' | '))

// ---- 重建 moof：每轨一个 traf，tfhd 原样保留，trun 只改 data_offset ----
function buildMoof(moofStart, mdatPayloadStart) {
  const trafs = []
  for (const id of trackIds) {
    const myRuns = runs.filter(r => r.trackId === id)
    const tfhdBox = top.length ? null : null
    // 找一个原始 tfhd 作为模板
    void tfhdBox
    const trunBoxes = []
    // 每个 trun 的样本在 mdat 里的起点
    const offsets = []
    let cursor = mdatPayloadStart
    for (const r of myRuns) {
      offsets.push(cursor)
      for (let i = 0; i < r.count; i++) {
        cursor += globalSamples[r.globalStart + i].size ?? 0
      }
    }
    const isAudio = id === trackIds[0]
    myRuns.forEach((r, idx) => {
      let f = r.flags
      if (safari && isAudio) f = f & ~0x000100 // 音频：trun 不带每样本时长，只用 tfhd 默认值
      const parts = [u32(f), u32(r.count)]
      if (f & 0x000001) parts.push(u32(offsets[idx] - moofStart))
      if (f & 0x000004) parts.push(u32(0)) // first_sample_flags
      for (let i = 0; i < r.count; i++) {
        const s = globalSamples[r.globalStart + i]
        if (f & 0x000100) {
          let d = s.duration ?? 0
          if (videoTs600 && !isAudio) d = Math.round(d * videoScale) // 视频时基 30000 → 600
          parts.push(u32(d))
        }
        if (f & 0x000200) parts.push(u32(s.size ?? 0))
        if (f & 0x000400) parts.push(u32(s.flags ?? 0))
        if (f & 0x000800) parts.push(u32(s.cts ?? 0))
      }
      trunBoxes.push(box('trun', ...parts))
    })

    // tfhd：原样复制（保留全部标志）
    let tfhdTemplate
    if (safari && isAudio) {
      // Safari：音频 tfhd 带 default_sample_duration，trun 不带每样本时长
      tfhdTemplate = box('tfhd', u32(0x000008), u32(id), u32(1022))
    } else {
      tfhdTemplate = findTfhd(id)
    }
    const tfdtValue = safari && !isAudio ? 26 : 0
    const tfdt = box('tfdt', u32(1), u32(tfdtValue))
    trafs.push(box('traf', tfhdTemplate, tfdt, ...trunBoxes))
  }
  return box('moof', box('mfhd', u32(1)), ...trafs)
}

function findTfhd(trackId) {
  for (const moof of moofs) {
    for (const traf of boxes(moof.dataStart, moof.dataStart + moof.size).filter(b => b.type === 'traf')) {
      const tf = boxes(traf.dataStart, traf.dataStart + traf.size)
      const tfhdBox = tf.find(x => x.type === 'tfhd')
      if (!tfhdBox) continue
      if (dv.getUint32(tfhdBox.dataStart + 4) !== trackId) continue
      return src.slice(tfhdBox.start, tfhdBox.start + tfhdBox.size)
    }
  }
  throw new Error('找不到 tfhd')
}

const mdatPayload = concat(globalSamples.map(s => s.data))

const ftyp = src.slice(ftypBox.start, ftypBox.start + ftypBox.size)
let moov = src.slice(moovBox.start, moovBox.start + moovBox.size)

{
  // 在整份文件的副本上打补丁（偏移量与原文件一致），最后再切出 moov
  const whole = new Uint8Array(src)
  const wdv = new DataView(whole.buffer)
  const moovChildren = boxes(moovBox.dataStart, moovBox.start + moovBox.size)
  const mvhd = moovChildren.find(b => b.type === 'mvhd')
  const mvhdV = dv.getUint8(mvhd.dataStart)
  const mvhdTsOff = mvhd.dataStart + (mvhdV === 1 ? 20 : 12)
  const mvhdDurOff = mvhd.dataStart + (mvhdV === 1 ? 24 : 16)
  if (patchSafariMvhd || ts600) wdv.setUint32(mvhdTsOff, 600) // mvhd timescale → 600
  if (patchSafariMvhd) {
    if (mvhdV === 1) wdv.setBigUint64(mvhdDurOff, 0n)
    else wdv.setUint32(mvhdDurOff, 0)
  }
  for (const trak of moovChildren.filter(b => b.type === 'trak')) {
    const tk = boxes(trak.dataStart, trak.start + trak.size)
    const tkhd = tk.find(b => b.type === 'tkhd')
    const mdia = tk.find(b => b.type === 'mdia')
    const md = mdia ? boxes(mdia.dataStart, mdia.start + mdia.size) : []
    const mdhd = md.find(b => b.type === 'mdhd')
    const hdlr = md.find(b => b.type === 'hdlr')
    const kind = hdlr ? String.fromCharCode(...whole.slice(hdlr.dataStart + 8, hdlr.dataStart + 12)) : '?'
    const tkhdV = tkhd ? dv.getUint8(tkhd.dataStart) : 0
    const tkhdDurOff = tkhd ? tkhd.dataStart + (tkhdV === 1 ? 28 : 20) : 0
    const mdhdV = mdhd ? dv.getUint8(mdhd.dataStart) : 0
    const mdhdTsOff = mdhd ? mdhd.dataStart + (mdhdV === 1 ? 20 : 12) : 0
    const mdhdDurOff = mdhd ? mdhd.dataStart + (mdhdV === 1 ? 24 : 16) : 0
    if (zeroDur) {
      if (tkhd) { if (tkhdV === 1) wdv.setBigUint64(tkhdDurOff, 0n); else wdv.setUint32(tkhdDurOff, 0) }
      if (mdhd) { if (mdhdV === 1) wdv.setBigUint64(mdhdDurOff, 0n); else wdv.setUint32(mdhdDurOff, 0) }
    }
    if (videoTs600 && kind === 'vide' && mdhd) wdv.setUint32(mdhdTsOff, 600)
  }
  moov = whole.slice(moovBox.start, moovBox.start + moovBox.size)
}

const moofProbe = buildMoof(0, 0)
const moofSize = moofProbe.length
const moofStart = ftyp.length + moov.length
const mdatPayloadStart = moofStart + moofSize + 8
const moof = buildMoof(moofStart, mdatPayloadStart)
const mdat = box('mdat', mdatPayload)

writeFileSync(outFile, concat([ftyp, moov, moof, mdat]))
console.log('已写出', outFile, `moof=${moofSize} mdat=${mdatPayload.length}`)
