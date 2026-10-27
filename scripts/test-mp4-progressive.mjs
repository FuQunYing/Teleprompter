// 验证 fragmented mp4 → progressive mp4 转换。
// 运行：npm run test:mp4
import { toProgressiveMp4 } from '../src/mp4Progressive.ts'

const enc = new TextEncoder()
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
function boxes(bytes, start, end) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
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

let failures = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}

// ---- 造一个 fragmented mp4：2 条轨，一个 moof 两个 traf ----
const ftyp = box('ftyp', enc.encode('isom'), u32(512), enc.encode('isomiso6mp41'))
const mvhd = box('mvhd', u32(0), u32(0), u32(0), u32(1000), u32(0))
const tkhd = id => box('tkhd', u32(0), u32(0), u32(0), u32(id), u32(0), u32(0), new Uint8Array(60))
const mdhd = ts => box('mdhd', u32(0), u32(0), u32(0), u32(ts), u32(0))
const hdlr = kind => box('hdlr', u32(0), u32(0), enc.encode(kind), new Uint8Array(12), enc.encode('x\0'))
const stbl = box('stbl', box('stsd', u32(0), u32(0)), box('stts', u32(0), u32(0)))
const minf = box('minf', stbl)
const trak = (id, kind, ts) => box('trak', tkhd(id), box('mdia', mdhd(ts), hdlr(kind), minf))
const trex = id => box('trex', u32(0), u32(id), u32(1), u32(0), u32(0), u32(0))
const mvex = box('mvex', trex(1), trex(2))
const moov = box('moov', mvhd, trak(1, 'soun', 48000), trak(2, 'vide', 600), mvex)

const tfhd = (id, defDur) => box('tfhd', u32(0x000008), u32(id), u32(defDur))
const tfdt = box('tfdt', u32(1), u32(0))
// 音频：10 个样本，每个 1021（48000 时基）→ 0.2127s
// 音频：trun 带每样本大小（时长来自 tfhd 的默认值）
const audioTrun = box('trun', u32(0x000201), u32(10), u32(0),
  ...Array.from({ length: 10 }, () => u32(10)))
// 视频：5 个样本，每个 300（600 时基）→ 0.5s
const videoTrun = box('trun', u32(0x000201), u32(5), u32(0),
  ...Array.from({ length: 5 }, () => u32(20)))
const moof = box('moof', box('mfhd', u32(0), u32(1)),
  box('traf', tfhd(1, 1021), tfdt, audioTrun),
  box('traf', tfhd(2, 300), tfdt, videoTrun))
const mdat = box('mdat', new Uint8Array(10 * 10 + 5 * 20))

const fragmented = new Blob([concat([ftyp, moov, moof, mdat])], { type: 'video/mp4' })

console.log('--- fragmented → progressive ---')
const result = await toProgressiveMp4(fragmented)
check('发生了转换', result.changed, true)
check('轨数量', result.tracks.length, 2)
check('音频样本数', result.tracks[0].samples, 10)
check('视频样本数', result.tracks[1].samples, 5)
check('音频时长(s)', Number(result.tracks[0].duration.toFixed(4)), 0.2127)
check('视频时长(s)', Number(result.tracks[1].duration.toFixed(4)), 2.5)

const bytes = new Uint8Array(await result.blob.arrayBuffer())
const top = boxes(bytes, 0, bytes.length).map(b => b.type)
check('顶层 box', top.join(' '), 'ftyp moov mdat')

const moovBox = boxes(bytes, 0, bytes.length).find(b => b.type === 'moov')
const moovKids = boxes(bytes, moovBox.dataStart, moovBox.start + moovBox.size)
check('moov 里没有 mvex', moovKids.some(b => b.type === 'mvex'), false)
const trakBox = moovKids.find(b => b.type === 'trak')
const trakKids = boxes(bytes, trakBox.dataStart, trakBox.start + trakBox.size)
const mdia = trakKids.find(b => b.type === 'mdia')
const mdiaKids = boxes(bytes, mdia.dataStart, mdia.start + mdia.size)
const minfBox = mdiaKids.find(b => b.type === 'minf')
const stblBox = boxes(bytes, minfBox.dataStart, minfBox.start + minfBox.size).find(b => b.type === 'stbl')
const stblKids = boxes(bytes, stblBox.dataStart, stblBox.start + stblBox.size)
check('stbl 里的表', stblKids.map(b => b.type).join(' '), 'stsd stts stsc stsz stco')

const stts = stblKids.find(b => b.type === 'stts')
const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
check('stts 条目数', dv.getUint32(stts.dataStart + 4), 1)
check('stts count', dv.getUint32(stts.dataStart + 8), 10)
check('stts delta', dv.getUint32(stts.dataStart + 12), 1021)


const stsz = stblKids.find(b => b.type === 'stsz')
check('stsz 样本数', dv.getUint32(stsz.dataStart + 8), 10)

const stco = stblKids.find(b => b.type === 'stco')
const chunkOffset = dv.getUint32(stco.dataStart + 8)
const mdatBox = boxes(bytes, 0, bytes.length).find(b => b.type === 'mdat')
console.log('    调试: stco=', chunkOffset, 'mdat.start=', mdatBox.start, 'mdat.size=', mdatBox.size)
check('stco 指向 mdat 内', chunkOffset >= mdatBox.start + 8 && chunkOffset < mdatBox.start + mdatBox.size, true)

// 已经是 progressive 的输入应原样返回
console.log('\n--- 幂等：progressive 输入不再转换 ---')
const again = await toProgressiveMp4(result.blob)
check('未再转换', again.changed, false)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
