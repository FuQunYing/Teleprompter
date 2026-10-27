// 打印 mp4 里各处的时长字段，用于人工核对。
// 用法：node --experimental-strip-types scripts/inspect-mp4.mjs <file>
import { readFileSync } from 'node:fs'
import { fixMp4Duration } from '../src/mp4Duration.ts'

const file = process.argv[2]
const bytes = new Uint8Array(readFileSync(file))
const enc = new TextEncoder()
const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

function boxes(start, end) {
  const out = []
  let p = start
  while (p + 8 <= end) {
    const size = dv.getUint32(p)
    const type = String.fromCharCode(...bytes.slice(p + 4, p + 8))
    if (size < 8 || p + size > end) break
    out.push({ type, start: p, size, dataStart: p + 8 })
    p += size
  }
  return out
}
const fourcc = off => String.fromCharCode(...bytes.slice(off, off + 4))

console.log('文件:', file, `(${(bytes.length / 1024 / 1024).toFixed(2)} MB)`)
console.log('顶层 box:', boxes(0, bytes.length).map(b => b.type).join(' '))

for (const b of boxes(0, bytes.length)) {
  if (b.type === 'moov') {
    for (const c of boxes(b.dataStart, b.dataStart + b.size)) {
      if (c.type === 'mvhd') {
        const v = dv.getUint8(c.dataStart)
        const ts = dv.getUint32(c.dataStart + (v === 1 ? 20 : 12))
        const dur = v === 1 ? Number(dv.getBigUint64(c.dataStart + 24)) : dv.getUint32(c.dataStart + 16)
        console.log(`  mvhd: timescale=${ts} duration=${dur} (${(dur / ts).toFixed(3)}s)`)
      }
      if (c.type === 'trak') {
        const tk = boxes(c.dataStart, c.dataStart + c.size)
        const tkhd = tk.find(x => x.type === 'tkhd')
        const mdia = tk.find(x => x.type === 'mdia')
        const md = mdia ? boxes(mdia.dataStart, mdia.dataStart + mdia.size) : []
        const mdhd = md.find(x => x.type === 'mdhd')
        const hdlr = md.find(x => x.type === 'hdlr')
        const kind = hdlr ? fourcc(hdlr.dataStart + 8) : '?'
        let tkhdDur = '-'
        if (tkhd) {
          const v = dv.getUint8(tkhd.dataStart)
          tkhdDur = String(v === 1 ? Number(dv.getBigUint64(tkhd.dataStart + 28)) : dv.getUint32(tkhd.dataStart + 20))
        }
        let mdhdInfo = '-'
        if (mdhd) {
          const v = dv.getUint8(mdhd.dataStart)
          const ts = dv.getUint32(mdhd.dataStart + (v === 1 ? 20 : 12))
          const dur = v === 1 ? Number(dv.getBigUint64(mdhd.dataStart + 24)) : dv.getUint32(mdhd.dataStart + 16)
          mdhdInfo = `timescale=${ts} duration=${dur} (${(dur / ts).toFixed(3)}s)`
        }
        console.log(`  trak ${kind}: tkhd.duration=${tkhdDur}  mdhd ${mdhdInfo}`)
      }
    }
  }
}

const blob = new Blob([bytes], { type: 'video/mp4' })
const res = await fixMp4Duration(blob)
console.log('\n分析器结论:')
console.log('  fragmented:', res.analysis.fragmented)
console.log('  真实时长:', res.analysis.duration.toFixed(3), 's')
console.log('  原始标注:', (res.analysis.storedMovieDuration / res.analysis.movieTimescale).toFixed(3), 's')
console.log('  tracks:', res.analysis.tracks.map(t => `${t.kind} stored=${t.storedDuration} computed=${t.computedDuration}`).join(' | '))
console.log('  需要修正:', res.changed)
void enc
