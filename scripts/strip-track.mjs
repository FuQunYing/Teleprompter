// 生成「只保留某一条轨」的 mp4 变体（只重建 moov，moof/mdat 原样保留——
// trun 的 data_offset 是相对 moof 起点的，moov 变长不影响）。
// 用法: node scripts/strip-track.mjs <输入.mp4> <保留 vide|soun> <输出.mp4>
import { readFileSync, writeFileSync } from 'node:fs'

const [, , inFile, keep, outFile] = process.argv
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
function fourcc(off) { return String.fromCharCode(...src.slice(off, off + 4)) }

const top = boxes(0, src.length)
const moovBox = top.find(b => b.type === 'moov')
const moovChildren = boxes(moovBox.dataStart, moovBox.start + moovBox.size)

const keepTraks = []
for (const trak of moovChildren.filter(b => b.type === 'trak')) {
  const tk = boxes(trak.dataStart, trak.start + trak.size)
  const mdia = tk.find(b => b.type === 'mdia')
  const md = mdia ? boxes(mdia.dataStart, mdia.start + mdia.size) : []
  const hdlr = md.find(b => b.type === 'hdlr')
  const kind = hdlr ? fourcc(hdlr.dataStart + 8) : '?'
  const isVideo = kind === 'vide'
  if (isVideo === (keep === 'vide')) keepTraks.push(src.slice(trak.start, trak.start + trak.size))
}

// 重建 moov：mvhd + 保留的 trak + mvex
const mvhd = moovChildren.find(b => b.type === 'mvhd')
const mvex = moovChildren.find(b => b.type === 'mvex')
const parts = [src.slice(mvhd.start, mvhd.start + mvhd.size), ...keepTraks]
if (mvex) parts.push(src.slice(mvex.start, mvex.start + mvex.size))
const moovPayload = concat(parts)
const moovHeader = new Uint8Array(8)
new DataView(moovHeader.buffer).setUint32(0, moovPayload.length + 8)
moovHeader.set(enc.encode('moov'), 4)
const newMoov = concat([moovHeader, moovPayload])

const out = [src.slice(0, moovBox.start), newMoov, src.slice(moovBox.start + moovBox.size)]
writeFileSync(outFile, concat(out))
console.log('已写出', outFile, `保留 ${keep}，moov ${moovBox.size} → ${newMoov.length} 字节`)
