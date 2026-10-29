// 检查一个 mp4 对「剪辑软件（剪映/FCP/Prores 之类）」的友好度：
// 关键帧表(stss)、显示尺寸(tkhd)与编码尺寸(stsd)是否一致、帧率是否恒定、ftyp 品牌等。
// 用法: node scripts/inspect-editor-compat.mjs <文件.mp4>
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const src = new Uint8Array(readFileSync(file))
const dv = new DataView(src.buffer, src.byteOffset, src.byteLength)

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
const fourcc = off => String.fromCharCode(...src.slice(off, off + 4))

console.log('文件:', file, `(${(src.length / 1024 / 1024).toFixed(2)} MB)`)

// ftyp
const ftyp = boxes(0, src.length).find(b => b.type === 'ftyp')
if (ftyp) {
  const brands = []
  let p = ftyp.dataStart + 8
  while (p + 4 <= ftyp.start + ftyp.size) { brands.push(fourcc(p)); p += 4 }
  console.log('ftyp 品牌:', brands.join(' '))
}

const moov = boxes(0, src.length).find(b => b.type === 'moov')
const moovKids = boxes(moov.dataStart, moov.start + moov.size)
const mvhd = moovKids.find(b => b.type === 'mvhd')
const mvhdV = dv.getUint8(mvhd.dataStart)
const movieTs = dv.getUint32(mvhd.dataStart + (mvhdV === 1 ? 20 : 12))
const mvhdDur = mvhdV === 1 ? Number(dv.getBigUint64(mvhd.dataStart + 24)) : dv.getUint32(mvhd.dataStart + 16)
console.log(`mvhd: timescale=${movieTs} duration=${mvhdDur} (${(mvhdDur / movieTs).toFixed(3)}s)`)

for (const trak of moovKids.filter(b => b.type === 'trak')) {
  const tk = boxes(trak.dataStart, trak.start + trak.size)
  const tkhd = tk.find(b => b.type === 'tkhd')
  const mdia = tk.find(b => b.type === 'mdia')
  const md = boxes(mdia.dataStart, mdia.start + mdia.size)
  const mdhd = md.find(b => b.type === 'mdhd')
  const hdlr = md.find(b => b.type === 'hdlr')
  const minf = md.find(b => b.type === 'minf')
  const kind = hdlr ? fourcc(hdlr.dataStart + 8) : '?'

  const tkhdV = dv.getUint8(tkhd.dataStart)
  const tkhdFlags = dv.getUint32(tkhd.dataStart) & 0xffffff
  const tkhdDur = tkhdV === 1 ? Number(dv.getBigUint64(tkhd.dataStart + 28)) : dv.getUint32(tkhd.dataStart + 20)
  // width/height 是 16.16 定点，位于 tkhd payload 的最后 8 字节
  const whOff = tkhd.dataStart + tkhd.size - 8 - 8
  const tkhdW = dv.getUint32(whOff) / 65536
  const tkhdH = dv.getUint32(whOff + 4) / 65536

  const mdhdV = dv.getUint8(mdhd.dataStart)
  const ts = dv.getUint32(mdhd.dataStart + (mdhdV === 1 ? 20 : 12))
  const mdhdDur = mdhdV === 1 ? Number(dv.getBigUint64(mdhd.dataStart + 24)) : dv.getUint32(mdhd.dataStart + 16)

  const stbl = boxes(minf.dataStart, minf.start + minf.size).find(b => b.type === 'stbl')
  const stblKids = stbl ? boxes(stbl.dataStart, stbl.start + stbl.size) : []
  const names = stblKids.map(b => b.type)

  let coded = ''
  let stssInfo = '无 stss'
  let sttsInfo = ''
  const stsd = stblKids.find(b => b.type === 'stsd')
  if (stsd && kind === 'vide') {
    const avc1 = boxes(stsd.dataStart + 8, stsd.start + stsd.size).find(b => b.type === 'avc1')
    if (avc1) {
      const w = dv.getUint16(avc1.dataStart + 24)
      const h = dv.getUint16(avc1.dataStart + 26)
      coded = `${w}x${h}`
    }
  }
  const stss = stblKids.find(b => b.type === 'stss')
  if (stss) {
    const n = dv.getUint32(stss.dataStart + 4)
    stssInfo = `stss ${n} 个关键帧`
  }
  const stts = stblKids.find(b => b.type === 'stts')
  if (stts) {
    const n = dv.getUint32(stts.dataStart + 4)
    let total = 0
    const deltas = new Set()
    let p = stts.dataStart + 8
    for (let i = 0; i < n && p + 8 <= stts.start + stts.size; i++, p += 8) {
      const c = dv.getUint32(p), d = dv.getUint32(p + 4)
      total += c * d
      deltas.add(d)
    }
    const secs = total / ts
    sttsInfo = `stts ${n} 条, 时长=${secs.toFixed(3)}s, 帧时长种类=${deltas.size}` +
      (deltas.size <= 4 ? ` [${[...deltas].join(',')}]` : '') +
      ` 帧率≈${(total / ts / (dv.getUint32(stts.dataStart + 8))).toFixed(1)}fps`
  }

  console.log(`\n轨 ${kind}:`)
  console.log(`  tkhd: flags=0x${tkhdFlags.toString(16)} duration=${tkhdDur} (${(tkhdDur / movieTs).toFixed(3)}s) 显示尺寸=${tkhdW}x${tkhdH}`)
  console.log(`  mdhd: timescale=${ts} duration=${mdhdDur} (${(mdhdDur / ts).toFixed(3)}s)`)
  if (coded) console.log(`  stsd 编码尺寸=${coded}  ${tkhdW}x${tkhdH === coded.split('x')[1] ? '' : ''}`)
  console.log(`  stbl: ${names.join(' ')}`)
  console.log(`  ${stssInfo}`)
  console.log(`  ${sttsInfo}`)
}
