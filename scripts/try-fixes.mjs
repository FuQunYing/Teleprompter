// 对一个真实 mp4 批量试验各种「修时长」的候选方案，用 afinfo（AVFoundation，
// 与 iOS 相册同一引擎）测量每个方案的结果时长。
//
// 用法：node --experimental-strip-types scripts/try-fixes.mjs <文件.mp4>
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fixMp4Duration } from '../src/mp4Duration.ts'

const file = process.argv[2]
if (!file) {
  console.error('用法: node --experimental-strip-types scripts/try-fixes.mjs <文件.mp4>')
  process.exit(1)
}

const enc = new TextEncoder()
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
function concat(list) {
  const total = list.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const a of list) { out.set(a, p); p += a.length }
  return out
}
function fourcc(off) { return String.fromCharCode(...src.slice(off, off + 4)) }

function measure(name, bytes) {
  const path = `/tmp/try-${name}.mp4`
  writeFileSync(path, bytes)
  let out = ''
  try {
    out = execFileSync('afinfo', [path], { encoding: 'utf8' })
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '')
  }
  const m = out.match(/estimated duration:\s*([\d.]+)/)
  const dur = m ? m[1] : 'FAIL'
  const fail = out.includes('Fail')
  console.log(`  ${fail ? '✗' : '✓'} ${name.padEnd(28)} duration=${dur}`)
  return dur
}

// 找出 moov 里的各条轨
const top = boxes(0, src.length)
const moov = top.find(b => b.type === 'moov')
const moovChildren = boxes(moov.dataStart, moov.start + moov.size)
const mvhd = moovChildren.find(b => b.type === 'mvhd')
const traks = moovChildren.filter(b => b.type === 'trak')

function trackInfo(trak) {
  const tk = boxes(trak.dataStart, trak.start + trak.size)
  const tkhd = tk.find(b => b.type === 'tkhd')
  const mdia = tk.find(b => b.type === 'mdia')
  const md = mdia ? boxes(mdia.dataStart, mdia.start + mdia.size) : []
  const mdhd = md.find(b => b.type === 'mdhd')
  const hdlr = md.find(b => b.type === 'hdlr')
  const kind = hdlr ? fourcc(hdlr.dataStart + 8) : '?'
  return { tkhd, mdhd, kind }
}

const info = traks.map(trackInfo)
console.log('轨道:', info.map(i => i.kind).join(' | '))

const clone = () => new Uint8Array(src)

// 版本感知的时长字段
function durationField(box, kind) {
  if (!box) return null
  const v = dv.getUint8(box.dataStart)
  const offsets = {
    mvhd: v === 1 ? { o: 24, b: 8 } : { o: 16, b: 4 },
    tkhd: v === 1 ? { o: 28, b: 8 } : { o: 20, b: 4 },
    mdhd: v === 1 ? { o: 24, b: 8 } : { o: 16, b: 4 },
  }
  return { ...offsets[kind], v }
}

function writeDur(view, field, value) {
  if (!field) return
  if (field.b === 8) view.setBigUint64(field.o, BigInt(Math.round(value)))
  else view.setUint32(field.o, Math.round(value))
}

console.log('\n基线:')
measure('原始文件', src)

// 应用我们的修复器
const blob = new Blob([src], { type: 'video/mp4' })
const fixed = await fixMp4Duration(blob, undefined)
writeFileSync('/tmp/try-fixer.mp4', new Uint8Array(await fixed.blob.arrayBuffer()))
console.log(`  (修复器: changed=${fixed.changed} target=${fixed.targetDuration.toFixed(3)} source=${fixed.source})`)
measure('我们的修复器', new Uint8Array(await fixed.blob.arrayBuffer()))

// 候选方案：把某条轨的时长清零 / 只留一条轨的时长
for (let i = 0; i < info.length; i++) {
  for (const mode of ['zero-mdhd-tkhd', 'zero-both-tracks']) {
    const bytes = clone()
    const view = new DataView(bytes.buffer)
    const targets = mode === 'zero-mdhd-tkhd' ? [i] : info.map((_, k) => k)
    for (const k of targets) {
      const f = durationField(info[k].mdhd, 'mdhd')
      if (f) writeDur(view, f, 0)
      const t = durationField(info[k].tkhd, 'tkhd')
      if (t) writeDur(view, t, 0)
    }
    measure(`${mode}: ${info[i].kind}`, bytes)
  }
}

// 候选方案：mvhd.duration 清零
{
  const bytes = clone()
  const view = new DataView(bytes.buffer)
  const f = durationField(mvhd, 'mvhd')
  if (f) writeDur(view, f, 0)
  measure('mvhd.duration=0', bytes)
}

// 候选方案：清掉 trex 的 default_sample_duration
{
  const bytes = clone()
  const view = new DataView(bytes.buffer)
  const mvex = moovChildren.find(b => b.type === 'mvex')
  if (mvex) {
    for (const trex of boxes(mvex.dataStart, mvex.start + mvex.size).filter(b => b.type === 'trex')) {
      view.setUint32(trex.dataStart + 12, 0)
    }
  }
  measure('trex 默认时长清零', bytes)
}

// 候选方案：把每个 moof 的 tfdt 全部清零
{
  const bytes = clone()
  const view = new DataView(bytes.buffer)
  for (const moof of top.filter(b => b.type === 'moof')) {
    for (const traf of boxes(moof.dataStart, moof.start + moof.size).filter(b => b.type === 'traf')) {
      for (const tf of boxes(traf.dataStart, traf.start + traf.size)) {
        if (tf.type !== 'tfdt') continue
        const v = dv.getUint8(tf.dataStart)
        if (v === 1) view.setBigUint64(tf.dataStart + 4, 0n)
        else view.setUint32(tf.dataStart + 4, 0)
      }
    }
  }
  measure('所有 tfdt 清零', bytes)
}
