// 验证 fixMp4Duration：重建 fragmented mp4 的时间轴链 + 按真实时长缩放样本时长。
// 运行：npm run test:mp4
import { fixMp4Duration } from '../src/mp4Duration.ts'

const enc = new TextEncoder()

function concat(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const a of arrays) {
    out.set(a, p)
    p += a.length
  }
  return out
}
function u32(n) {
  const a = new Uint8Array(4)
  new DataView(a.buffer).setUint32(0, n)
  return a
}
function box(type, ...payloads) {
  const body = concat(payloads)
  const head = new Uint8Array(8)
  const dv = new DataView(head.buffer)
  dv.setUint32(0, body.length + 8)
  head.set(enc.encode(type), 4)
  return concat([head, body])
}

function topBoxes(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = []
  let p = 0
  while (p + 8 <= bytes.length) {
    const size = dv.getUint32(p)
    const type = String.fromCharCode(...bytes.slice(p + 4, p + 8))
    out.push({ type, start: p, dataStart: p + 8 })
    if (size < 8) break
    p += size
  }
  return out
}

/** 读回文件里 moov>mvhd 的 duration 与 timescale */
function readMvhd(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const moov = topBoxes(bytes).find(b => b.type === 'moov')
  if (!moov) return null
  const payload = moov.dataStart + 8
  const version = dv.getUint8(payload)
  const offset = version === 1 ? payload + 24 : payload + 16
  return {
    version,
    value: version === 1 ? Number(dv.getBigUint64(offset)) : dv.getUint32(offset),
    timescale: dv.getUint32(version === 1 ? payload + 20 : payload + 12),
  }
}

/** 读回所有 tfdt 的 baseMediaDecodeTime */
function readTfdtValues(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = []
  const walk = (start, end) => {
    let p = start
    while (p + 8 <= end) {
      const size = dv.getUint32(p)
      const type = String.fromCharCode(...bytes.slice(p + 4, p + 8))
      const dataStart = p + 8
      if (type === 'tfdt') {
        const version = dv.getUint8(dataStart)
        out.push(version === 1 ? Number(dv.getBigUint64(dataStart + 4)) : dv.getUint32(dataStart + 4))
      } else if (['moov', 'trak', 'mdia', 'minf', 'moof', 'traf'].includes(type)) {
        walk(dataStart, p + size)
      }
      if (size < 8) break
      p += size
    }
  }
  walk(0, bytes.length)
  return out
}

/** 读回所有 trun 里样本的 duration */
function readSampleDurations(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = []
  const walk = (start, end) => {
    let p = start
    while (p + 8 <= end) {
      const size = dv.getUint32(p)
      const type = String.fromCharCode(...bytes.slice(p + 4, p + 8))
      const dataStart = p + 8
      if (type === 'trun') {
        const flags = dv.getUint32(dataStart) & 0xffffff
        const count = dv.getUint32(dataStart + 4)
        let q = dataStart + 8
        if (flags & 0x000001) q += 4
        if (flags & 0x000004) q += 4
        if (flags & 0x000100) {
          for (let i = 0; i < count; i++) {
            out.push(dv.getUint32(q))
            q += 4
          }
        }
      } else if (['moof', 'traf'].includes(type)) {
        walk(dataStart, p + size)
      }
      if (size < 8) break
      p += size
    }
  }
  walk(0, bytes.length)
  return out
}

/** 找到 stts box 并读回 delta */
function readSttsDelta(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let found = null
  const walk = (start, end) => {
    let p = start
    while (p + 8 <= end) {
      const size = dv.getUint32(p)
      const type = String.fromCharCode(...bytes.slice(p + 4, p + 8))
      const dataStart = p + 8
      if (type === 'stts') {
        found = dv.getUint32(dataStart + 8 + 4)
        return
      }
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) walk(dataStart, p + size)
      if (size < 8) break
      p += size
    }
  }
  walk(0, bytes.length)
  return found
}

const now = 0xe5f00000
const BAD = 73522000 // 垃圾时长：20:25:22

const mvhd = (duration, timescale = 1000) =>
  box('mvhd', u32(0), u32(now), u32(now), u32(timescale), u32(duration))
const tkhd = (trackId, duration) =>
  box('tkhd', u32(0), u32(now), u32(now), u32(trackId), u32(0), u32(duration), new Uint8Array(60))
const mdhd = (timescale, duration) =>
  box('mdhd', u32(0), u32(now), u32(now), u32(timescale), u32(duration))
const hdlr = kind =>
  box('hdlr', u32(0), u32(0), enc.encode(kind), new Uint8Array(12), enc.encode('x\0'))
const stblEmpty = box('stbl', box('stsd', u32(0), u32(0)), box('stts', u32(0), u32(0)))
const minf = box('minf', stblEmpty)
const ftyp = box('ftyp', enc.encode('isom'), u32(512), enc.encode('isomiso6mp41'))
const mdat = box('mdat', new Uint8Array(512))
const tfhd = (trackId, defaultSampleDuration) =>
  box('tfhd', u32(0x000008), u32(trackId), u32(defaultSampleDuration))
const trun = (sampleCount, perSampleDuration) => {
  const parts = [u32(perSampleDuration ? 0x000100 : 0), u32(sampleCount)]
  if (perSampleDuration) for (let i = 0; i < sampleCount; i++) parts.push(u32(perSampleDuration))
  return box('trun', ...parts)
}

/** 造一个 fragmented 文件：每轨 trackId 个分片，每片 samplesPerFrag 个样本 */
function makeFragmented({ trackIds, timescale, samplesPerFrag, sampleDuration, tfdtMode }) {
  const moov = box('moov', mvhd(0),
    ...trackIds.map(id => box('trak', tkhd(id, 0),
      box('mdia', mdhd(timescale, 0), hdlr(id === 1 ? 'vide' : 'soun'), minf))))

  const parts = [ftyp, moov]
  for (const id of trackIds) {
    for (let f = 0; f < samplesPerFrag.fragments; f++) {
      let tfdtValue = 0
      if (tfdtMode === 'cumulative') tfdtValue = f * samplesPerFrag.count * sampleDuration
      else if (tfdtMode === 'allZero') tfdtValue = 0
      else if (tfdtMode === 'hugeLast' && f === samplesPerFrag.fragments - 1) tfdtValue = BAD

      parts.push(box('moof', box('mfhd', u32(f + 1)),
        box('traf', tfhd(id, sampleDuration),
          box('tfdt', u32(0), u32(tfdtValue)),
          trun(samplesPerFrag.count, sampleDuration))))
      parts.push(mdat)
    }
  }
  return new Blob([concat(parts)], { type: 'video/mp4' })
}

let failures = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}

// ============ 场景一：tfdt 链正常，无需改动 ============
console.log('--- 场景一：tfdt 链正常 ---')
const b1 = makeFragmented({
  trackIds: [1], timescale: 90000,
  samplesPerFrag: { fragments: 10, count: 30 }, sampleDuration: 3000,
  tfdtMode: 'cumulative',
})
const r1 = await fixMp4Duration(b1, 10)
check('容器时间轴(s)', r1.analysis.duration, 10)
const bytes1 = new Uint8Array(await r1.blob.arrayBuffer())
check('mvhd.duration', readMvhd(bytes1).value, 10000)
check('样本时长未被改动', readSampleDurations(bytes1).every(d => d === 3000), true)

// ============ 场景二：tfdt 全为 0（样本挤在开头）→ 重建时间轴 ============
console.log('\n--- 场景二：tfdt 全为 0，重建分片时间轴 ---')
const b2 = makeFragmented({
  trackIds: [1], timescale: 90000,
  samplesPerFrag: { fragments: 10, count: 30 }, sampleDuration: 3000,
  tfdtMode: 'allZero',
})
const r2 = await fixMp4Duration(b2, 10)
const bytes2 = new Uint8Array(await r2.blob.arrayBuffer())
const tfdts2 = readTfdtValues(bytes2)
check('分片数', tfdts2.length, 10)
check('第一个 tfdt', tfdts2[0], 0)
check('第二个 tfdt 应为前一片时长', tfdts2[1], 30 * 3000)
check('最后一个 tfdt', tfdts2[9], 9 * 30 * 3000)
check('mvhd.duration', readMvhd(bytes2).value, 10000)

// ============ 场景三：样本时长是真实值的 2 倍 → 缩放 ============
console.log('\n--- 场景三：容器时间轴是真实值的 2 倍，缩放样本时长 ---')
const b3 = makeFragmented({
  trackIds: [1], timescale: 90000,
  samplesPerFrag: { fragments: 10, count: 30 }, sampleDuration: 6000, // 每片 2 秒
  tfdtMode: 'cumulative',
})
const r3 = await fixMp4Duration(b3, 10)
check('容器原始时间轴(s)', r3.analysis.duration, 20)
const bytes3 = new Uint8Array(await r3.blob.arrayBuffer())
const durations3 = readSampleDurations(bytes3)
check('样本时长已减半', durations3[0], 3000)
check('所有样本都已缩放', durations3.every(d => d === 3000), true)
check('mvhd.duration', readMvhd(bytes3).value, 10000)

// ============ 场景四：最后一个 tfdt 是垃圾值 → 重建后不再有空洞 ============
console.log('\n--- 场景四：最后一个分片的 tfdt 是垃圾值 ---')
const b4 = makeFragmented({
  trackIds: [1], timescale: 90000,
  samplesPerFrag: { fragments: 10, count: 30 }, sampleDuration: 3000,
  tfdtMode: 'hugeLast',
})
const r4 = await fixMp4Duration(b4, 10)
const bytes4 = new Uint8Array(await r4.blob.arrayBuffer())
const tfdts4 = readTfdtValues(bytes4)
check('最后一个 tfdt 已被修正', tfdts4[9], 9 * 30 * 3000)
check('mvhd.duration', readMvhd(bytes4).value, 10000)

// ============ 场景五：非 fragmented（stts）→ 缩放 delta ============
console.log('\n--- 场景五：非 fragmented mp4 ---')
const stts = box('stts', u32(0), u32(1), u32(300), u32(6000)) // 300 帧 × 6000 = 1800000 → 20s
const stbl5 = box('stbl', box('stsd', u32(0), u32(0)), stts)
const moov5 = box('moov', mvhd(BAD),
  box('trak', tkhd(1, BAD), box('mdia', mdhd(90000, BAD), hdlr('vide'), box('minf', stbl5))))
const b5 = new Blob([concat([ftyp, moov5, mdat])], { type: 'video/mp4' })
const r5 = await fixMp4Duration(b5, 10)
check('容器原始时间轴(s)', r5.analysis.duration, 20)
const bytes5 = new Uint8Array(await r5.blob.arrayBuffer())
check('stts delta 已减半', readSttsDelta(bytes5), 3000)
check('mvhd.duration', readMvhd(bytes5).value, 10000)

// ============ 场景六：分片没有每样本时长，只能靠 tfdt ============
console.log('\n--- 场景六：trun 无每样本时长（时长只在 tfdt 里）---')
const trunNoDur = (sampleCount) => box('trun', u32(0), u32(sampleCount))
function makeFragmentedNoDur({ fragments, count, sampleDuration }) {
  const moov = box('moov', mvhd(0),
    box('trak', tkhd(1, 0), box('mdia', mdhd(90000, 0), hdlr('vide'), minf)))
  const parts = [ftyp, moov]
  for (let f = 0; f < fragments; f++) {
    parts.push(box('moof', box('mfhd', u32(f + 1)),
      box('traf', box('tfhd', u32(0), u32(1)),
        box('tfdt', u32(0), u32(f * count * sampleDuration)),
        trunNoDur(count))))
    parts.push(mdat)
  }
  return new Blob([concat(parts)], { type: 'video/mp4' })
}
const b6 = makeFragmentedNoDur({ fragments: 10, count: 30, sampleDuration: 3000 })
const r6 = await fixMp4Duration(b6, 10)
check('容器时间轴由 tfdt 推算(s)', r6.analysis.duration, 9)
const bytes6 = new Uint8Array(await r6.blob.arrayBuffer())
const tfdts6 = readTfdtValues(bytes6)
check('tfdt 被按比例缩放', tfdts6[1], Math.round((1 * 30 * 3000) * (10 / 9)))
check('mvhd.duration', readMvhd(bytes6).value, 10000)

// ============ 场景七：webm / 垃圾输入不崩 ============
console.log('\n--- 场景七：webm 与垃圾输入 ---')
const webm = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'video/webm' })
const r7 = await fixMp4Duration(webm, 10)
check('webm 未修改', r7.changed, false)

const junk = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])], { type: 'video/mp4' })
const r8 = await fixMp4Duration(junk, 10)
check('垃圾输入未崩溃', r7.changed, false)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
