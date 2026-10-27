// 分析真实 mp4 的分片时间轴，并在 Chrome 里读一次 <video>.duration。
// 用法：node --experimental-strip-types scripts/probe-file.mjs <文件.mp4>
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

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

const top = boxes(0, src.length)
console.log('顶层:', top.map(b => `${b.type}(${b.size})`).join(' '))

const moov = top.find(b => b.type === 'moov')
const moovChildren = boxes(moov.dataStart, moov.start + moov.size)
const mvhd = moovChildren.find(b => b.type === 'mvhd')
const mvhdV = dv.getUint8(mvhd.dataStart)
const movieTs = dv.getUint32(mvhd.dataStart + (mvhdV === 1 ? 20 : 12))
const movieDur = mvhdV === 1
  ? Number(dv.getBigUint64(mvhd.dataStart + 24))
  : dv.getUint32(mvhd.dataStart + 16)
console.log(`mvhd: timescale=${movieTs} duration=${movieDur} (${(movieDur / movieTs).toFixed(3)}s)`)

const trackMeta = []
for (const trak of moovChildren.filter(b => b.type === 'trak')) {
  const tk = boxes(trak.dataStart, trak.start + trak.size)
  const tkhd = tk.find(b => b.type === 'tkhd')
  const mdia = tk.find(b => b.type === 'mdia')
  const md = mdia ? boxes(mdia.dataStart, mdia.start + mdia.size) : []
  const mdhd = md.find(b => b.type === 'mdhd')
  const hdlr = md.find(b => b.type === 'hdlr')
  const mdhdV = dv.getUint8(mdhd.dataStart)
  const ts = dv.getUint32(mdhd.dataStart + (mdhdV === 1 ? 20 : 12))
  const dur = mdhdV === 1 ? Number(dv.getBigUint64(mdhd.dataStart + 24)) : dv.getUint32(mdhd.dataStart + 16)
  const tkhdV = dv.getUint8(tkhd.dataStart)
  const tkhdFlags = dv.getUint32(tkhd.dataStart) & 0xffffff
  const tkhdDur = tkhdV === 1 ? Number(dv.getBigUint64(tkhd.dataStart + 28)) : dv.getUint32(tkhd.dataStart + 20)
  trackMeta.push({
    kind: hdlr ? fourcc(hdlr.dataStart + 8) : '?',
    trackId: dv.getUint32(tkhd.dataStart + (tkhdV === 1 ? 20 : 12)),
    timescale: ts, mdhdDuration: dur, tkhdDuration: tkhdDur, tkhdFlags,
  })
}
for (const t of trackMeta) {
  console.log(`trak ${t.kind}: id=${t.trackId} mdhd.ts=${t.timescale} mdhd.dur=${t.mdhdDuration} (${(t.mdhdDuration / t.timescale).toFixed(3)}s) tkhd.dur=${t.tkhdDuration} tkhd.flags=0x${t.tkhdFlags.toString(16)}`)
}

// mvex / trex
const mvex = moovChildren.find(b => b.type === 'mvex')
if (mvex) {
  for (const trex of boxes(mvex.dataStart, mvex.start + mvex.size).filter(b => b.type === 'trex')) {
    console.log(`trex: track_id=${dv.getUint32(trex.dataStart + 4)} default_dur=${dv.getUint32(trex.dataStart + 12)} default_size=${dv.getUint32(trex.dataStart + 16)}`)
  }
}

// 分片
for (const moof of top.filter(b => b.type === 'moof')) {
  console.log(`moof (${moof.size} 字节)`)
  for (const traf of boxes(moof.dataStart, moof.start + moof.size).filter(b => b.type === 'traf')) {
    const tf = boxes(traf.dataStart, traf.start + traf.size)
    const tfhd = tf.find(b => b.type === 'tfhd')
    const tfdt = tf.find(b => b.type === 'tfdt')
    const flags = dv.getUint32(tfhd.dataStart) & 0xffffff
    let p = tfhd.dataStart + 8
    if (flags & 0x000001) p += 8
    if (flags & 0x000002) p += 4
    let defDur = null
    if (flags & 0x000008) { defDur = dv.getUint32(p); p += 4 }
    const trackId = dv.getUint32(tfhd.dataStart + 4)
    const tfdtV = dv.getUint8(tfdt.dataStart)
    const base = tfdtV === 1 ? Number(dv.getBigUint64(tfdt.dataStart + 4)) : dv.getUint32(tfdt.dataStart + 4)

    let totalSamples = 0
    let durSum = 0
    let hasDur = false
    const truns = tf.filter(b => b.type === 'trun')
    for (const t of truns) {
      const f = dv.getUint32(t.dataStart) & 0xffffff
      const count = dv.getUint32(t.dataStart + 4)
      totalSamples += count
      if (f & 0x000100) {
        hasDur = true
        const perSample = 4 + ((f & 0x200) ? 4 : 0) + ((f & 0x400) ? 4 : 0) + ((f & 0x800) ? 4 : 0)
        let q = t.dataStart + 8
        if (f & 0x000001) q += 4
        if (f & 0x000004) q += 4
        for (let i = 0; i < count; i++) { durSum += dv.getUint32(q); q += perSample }
      }
    }
    const meta = trackMeta.find(t => t.trackId === trackId)
    const ts = meta?.timescale ?? 1
    const timeline = hasDur ? durSum : (defDur ?? 0) * totalSamples
    console.log(`  traf track=${trackId}(${meta?.kind}) tfhd.flags=0x${flags.toString(16)} default_dur=${defDur} tfdt=${base} trun数=${truns.length} 样本=${totalSamples} 每样本时长=${hasDur} 时间轴=${timeline} (${(timeline / ts).toFixed(3)}s)`)
    // 每个 trun 的 data_offset，看看样本在 mdat 里的排布
    const offs = truns.map(t => {
      const f = dv.getUint32(t.dataStart) & 0xffffff
      return f & 0x000001 ? dv.getInt32(t.dataStart + 8) : null
    })
    console.log(`    data_offset: [${offs.join(', ')}]`)
  }
}

// ---- Chrome 读一次 duration ----
const PORT = 9334
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  '--ignore-certificate-errors',
  '--user-data-dir=/tmp/tp-probe-profile', '--no-first-run',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' })

let ws
let nextId = 1
const pending = new Map()
const send = (method, params = {}) => {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
try {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())
      const page = list.find(t => t.type === 'page')
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise(r => { ws.onopen = r })
        ws.onmessage = ev => {
          const m = JSON.parse(ev.data)
          if (m.id && pending.has(m.id)) {
            const { resolve, reject } = pending.get(m.id)
            pending.delete(m.id)
            m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
          }
        }
        break
      }
    } catch {}
    await sleep(250)
  }
  await send('Page.enable')
  await send('Runtime.enable')
  const res = await send('Runtime.evaluate', {
    expression: `(async () => {
      const v = document.createElement('video')
      v.src = ${JSON.stringify(process.env.PROBE_URL || 'https://localhost:5173/probe.mp4')}
      await new Promise((ok, bad) => { v.onloadedmetadata = ok; v.onerror = () => bad(new Error('load error')); setTimeout(ok, 8000) })
      return JSON.stringify({ duration: v.duration, w: v.videoWidth, h: v.videoHeight })
    })()`,
    awaitPromise: true, returnByValue: true,
  })
  console.log('\nChrome <video>.duration →', res.result.value ?? JSON.stringify(res.exceptionDetails))
} finally {
  try { ws?.close() } catch {}
  chrome.kill()
}
