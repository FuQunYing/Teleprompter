// 构造 fragmented / 非 fragmented mp4，验证 fixMp4Duration 能把错误的 moov 时长改回来。
// 运行：node --experimental-strip-types scripts/test-mp4-duration.mjs
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

/** 扫描顶层 box，返回 {type, start, dataStart} */
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

/** 读文件里 mvhd.duration（原始值） */
function readMvhdDuration(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const moov = topBoxes(bytes).find(b => b.type === 'moov')
  if (!moov) return null
  // moov 的第一个子 box 是 mvhd
  const mvhdStart = moov.dataStart
  const mvhdPayload = mvhdStart + 8
  const version = dv.getUint8(mvhdPayload)
  const offset = version === 1 ? mvhdPayload + 24 : mvhdPayload + 16
  const value = version === 1 ? Number(dv.getBigUint64(offset)) : dv.getUint32(offset)
  return { version, value, timescale: dv.getUint32(version === 1 ? mvhdPayload + 20 : mvhdPayload + 12) }
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

const stbl = box('stbl', box('stsd', u32(0), u32(0)), box('stts', u32(0), u32(0)))
const minf = box('minf', stbl)
const ftyp = box('ftyp', enc.encode('isom'), u32(512), enc.encode('isomiso6mp41'))
const mdat = box('mdat', new Uint8Array(1024))

const tfhd = (trackId, defaultSampleDuration) =>
  box('tfhd', u32(0x000008), u32(trackId), u32(defaultSampleDuration))
const tfdt = box('tfdt', u32(0), u32(0))
const trun = (sampleCount, perSampleDuration) => {
  const parts = [u32(perSampleDuration ? 0x000100 : 0), u32(sampleCount)]
  if (perSampleDuration) for (let i = 0; i < sampleCount; i++) parts.push(u32(perSampleDuration))
  return box('trun', ...parts)
}

let failures = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}

// ===================== 场景一：fragmented mp4 =====================
console.log('--- 场景一：fragmented mp4（30 帧 @30fps + 30 帧 @48kHz）---')
const moovFrag = box('moov',
  mvhd(BAD),
  box('trak', tkhd(1, BAD), box('mdia', mdhd(90000, BAD), hdlr('vide'), minf)),
  box('trak', tkhd(2, BAD), box('mdia', mdhd(48000, BAD), hdlr('soun'), minf)))

const moofVideo = box('moof', box('mfhd', u32(1)),
  box('traf', tfhd(1, 3000), tfdt, trun(30, 3000)))
const moofAudio = box('moof', box('mfhd', u32(2)),
  box('traf', tfhd(2, 1600), tfdt, trun(30, 0)))

const blob1 = new Blob([concat([ftyp, moovFrag, moofVideo, mdat, moofAudio, mdat])], { type: 'video/mp4' })
const r1 = await fixMp4Duration(blob1)
check('识别为 fragmented', r1.analysis.fragmented, true)
check('原始标注时长(s)', r1.analysis.storedMovieDuration / r1.analysis.movieTimescale, 73522)
check('计算出的真实时长(s)', r1.analysis.duration, 1)
check('发生了修正', r1.changed, true)
const bytes1 = new Uint8Array(await r1.blob.arrayBuffer())
check('文件内 mvhd.duration', readMvhdDuration(bytes1).value, 1000)

// 再跑一次应无变化
const r1b = await fixMp4Duration(r1.blob)
check('幂等：第二次不再改动', r1b.changed, false)

// ===================== 场景二：非 fragmented mp4 =====================
console.log('\n--- 场景二：非 fragmented mp4（stts）---')
const stts = box('stts', u32(0), u32(1), u32(30), u32(3000)) // 30 帧 × 3000 = 90000 → 1s
const stbl2 = box('stbl', box('stsd', u32(0), u32(0)), stts)
const moovPlain = box('moov', mvhd(BAD),
  box('trak', tkhd(1, BAD), box('mdia', mdhd(90000, BAD), hdlr('vide'), box('minf', stbl2))))
const blob2 = new Blob([concat([ftyp, moovPlain, mdat])], { type: 'video/mp4' })
const r2 = await fixMp4Duration(blob2)
check('识别为非 fragmented', r2.analysis.fragmented, false)
check('计算出的真实时长(s)', r2.analysis.duration, 1)
check('发生了修正', r2.changed, true)
const bytes2 = new Uint8Array(await r2.blob.arrayBuffer())
check('文件内 mvhd.duration', readMvhdDuration(bytes2).value, 1000)

// ===================== 场景三：时长本来就正确 =====================
console.log('\n--- 场景三：时长本来就正确，不应改动 ---')
const moovOk = box('moov', mvhd(1000),
  box('trak', tkhd(1, 1000), box('mdia', mdhd(90000, 90000), hdlr('vide'), box('minf', stbl2))))
const blob3 = new Blob([concat([ftyp, moovOk, mdat])], { type: 'video/mp4' })
const r3 = await fixMp4Duration(blob3)
check('计算出的真实时长(s)', r3.analysis.duration, 1)
check('未发生无谓改动', r3.changed, false)

// ===================== 场景六：容器时间戳是垃圾 → 用实际录制时长 =====================
console.log('\n--- 场景六：分片时间戳是垃圾（8000s），传入实际录制时长 30s ---')
const moofGarbage = box('moof', box('mfhd', u32(1)),
  box('traf', tfhd(1, 24000000), tfdt, trun(30, 24000000)))
const blob6 = new Blob([concat([ftyp, moovFrag, moofGarbage, mdat])], { type: 'video/mp4' })
const r6 = await fixMp4Duration(blob6, 30)
check('来源为实际录制时长', r6.source, 'expected')
check('最终时长(s)', r6.targetDuration, 30)
const bytes6 = new Uint8Array(await r6.blob.arrayBuffer())
check('文件内 mvhd.duration', readMvhdDuration(bytes6).value, 30000)

// ===================== 场景七：容器没有任何时间信息 =====================
console.log('\n--- 场景七：容器无时间信息，用实际录制时长 ---')
const blob7 = new Blob([concat([ftyp, moovFrag, mdat])], { type: 'video/mp4' })
const r7 = await fixMp4Duration(blob7, 12.5)
check('来源为实际录制时长', r7.source, 'expected')
check('最终时长(s)', r7.targetDuration, 12.5)
const bytes7 = new Uint8Array(await r7.blob.arrayBuffer())
check('文件内 mvhd.duration', readMvhdDuration(bytes7).value, 12500)

// ===================== 场景四：非 mp4（webm）原样返回 =====================
console.log('\n--- 场景四：webm 原样返回 ---')
const webm = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'video/webm' })
const r4 = await fixMp4Duration(webm)
check('未修改', r4.changed, false)
check('blob 体积不变', r4.blob.size, webm.size)

// ===================== 场景五：垃圾输入不崩 =====================
console.log('\n--- 场景五：垃圾输入 ---')
const junk = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])], { type: 'video/mp4' })
const r5 = await fixMp4Duration(junk)
check('未崩溃且原样返回', r5.changed, false)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
