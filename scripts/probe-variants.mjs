// 对真实 mp4 生成若干「候选修复」变体，并用 macOS Safari 逐个测 <video>.duration。
// 用法：node scripts/probe-variants.mjs <文件.mp4>
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
const moov = top.find(b => b.type === 'moov')
const moovChildren = boxes(moov.dataStart, moov.start + moov.size)
const mvhd = moovChildren.find(b => b.type === 'mvhd')
const traks = moovChildren.filter(b => b.type === 'trak')

const tracks = traks.map(trak => {
  const tk = boxes(trak.dataStart, trak.start + trak.size)
  const tkhd = tk.find(b => b.type === 'tkhd')
  const mdia = tk.find(b => b.type === 'mdia')
  const md = mdia ? boxes(mdia.dataStart, mdia.start + mdia.size) : []
  const mdhd = md.find(b => b.type === 'mdhd')
  const hdlr = md.find(b => b.type === 'hdlr')
  const v = dv.getUint8(tkhd.dataStart)
  return {
    kind: hdlr ? fourcc(hdlr.dataStart + 8) : '?',
    tkhd, mdhd,
    tkhdFlagsOff: tkhd.dataStart + 1, // flags 的低 24 位
    tkhdFlags: dv.getUint32(tkhd.dataStart) & 0xffffff,
    tkhdDurOff: tkhd.dataStart + (v === 1 ? 28 : 20),
    tkhdDurBytes: v === 1 ? 8 : 4,
    mdhdV: dv.getUint8(mdhd.dataStart),
    mdhdDurOff: mdhd.dataStart + (dv.getUint8(mdhd.dataStart) === 1 ? 24 : 16),
    mdhdDurBytes: dv.getUint8(mdhd.dataStart) === 1 ? 8 : 4,
  }
})
const movieTsOff = mvhd.dataStart + (dv.getUint8(mvhd.dataStart) === 1 ? 20 : 12)
const movieDurOff = mvhd.dataStart + (dv.getUint8(mvhd.dataStart) === 1 ? 24 : 16)
const movieDurBytes = dv.getUint8(mvhd.dataStart) === 1 ? 8 : 4

console.log('轨道:', tracks.map(t => `${t.kind}(flags=0x${t.tkhdFlags.toString(16)})`).join(' | '))

const variants = []
function variant(name, mutate) {
  const bytes = new Uint8Array(src)
  const view = new DataView(bytes.buffer)
  mutate(view, bytes)
  const path = `/tmp/var-${name}.mp4`
  writeFileSync(path, bytes)
  variants.push({ name, path })
}

variant('00-baseline', () => {})

for (const flags of [0x3, 0x7, 0x5]) {
  variant(`01-tkhd-flags-0x${flags.toString(16)}`, (view) => {
    for (const t of tracks) {
      const v = view.getUint8(t.tkhd.dataStart)
      view.setUint32(t.tkhd.dataStart, (v << 24) | flags)
    }
  })
}

// 只改视频轨 / 只改音频轨的 flags
for (const t of tracks) {
  variant(`02-flags-0x7-${t.kind}`, (view) => {
    for (const x of tracks) {
      const v = view.getUint8(x.tkhd.dataStart)
      const f = x.kind === t.kind ? 0x7 : x.tkhdFlags
      view.setUint32(x.tkhd.dataStart, (v << 24) | f)
    }
  })
}

// 把某条轨的时长清零
for (const t of tracks) {
  variant(`03-zero-dur-${t.kind}`, (view) => {
    const x = tracks.find(y => y.kind === t.kind)
    view.setUint32(x.mdhdDurOff, 0)
    view.setUint32(x.tkhdDurOff, 0)
  })
}

// mvhd.duration 清零
variant('04-mvhd-zero', (view) => { view.setUint32(movieDurOff, 0) })

// 所有 tfdt 清零
variant('05-tfdt-zero', (view) => {
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
})

// ---- 用 Safari 逐个测量 ----
const html = `<!doctype html><meta charset="utf-8"><title>loading</title>
<body style="font:28px monospace;padding:20px"><div id="out"></div>
<video id="v" style="width:200px"></video>
<script>
const v=document.getElementById('v')
v.src=new URLSearchParams(location.search).get('f')
const show=d=>{document.title='DUR:'+d;document.getElementById('out').textContent='duration = '+d+' 秒'}
v.onloadedmetadata=()=>show(v.duration)
v.onerror=()=>{document.title='DUR:error'}
setTimeout(()=>{if(document.title==='loading'){document.title='DUR:timeout'}},15000)
</script>`
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'varprobe-'))
writeFileSync(join(dir, 'p.html'), html)
for (const v of variants) writeFileSync(join(dir, `${v.name}.mp4`), readFileSync(v.path))

const { createServer } = await import('node:http')
const server = createServer((req, res) => {
  const p = join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\//, ''))
  if (!p.endsWith('.html') && !p.endsWith('.mp4')) { res.writeHead(404).end(); return }
  const data = readFileSync(p)
  const type = p.endsWith('.html') ? 'text/html' : 'video/mp4'
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    const start = m && m[1] ? Number(m[1]) : 0
    const end = m && m[2] ? Number(m[2]) : data.length - 1
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 })
    res.end(data.slice(start, end + 1))
    return
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': data.length })
  res.end(data)
}).listen(8081)

async function safariDuration(name) {
  const url = `http://localhost:8081/p.html?f=${encodeURIComponent(name + '.mp4')}`
  execFileSync('osascript', ['-e', `tell application "Safari" to set URL of front document to "${url}"`])
  for (let i = 0; i < 60; i++) {
    await sleep(400)
    let title = ''
    try {
      title = execFileSync('osascript', ['-e', `
        tell application "Safari"
          set n to name of front document
          if n starts with "DUR:" then return n
          return ""
        end tell`], { encoding: 'utf8' }).trim()
    } catch {}
    if (title) {
      try { execFileSync('osascript', ['-e', 'tell application "Safari" to set URL of front document to "about:blank"']) } catch {}
      return title.replace('DUR:', '')
    }
  }
  return 'timeout'
}

try {
  for (const v of variants) {
    const dur = await safariDuration(v.name)
    let af = ''
    try {
      const out = execFileSync('afinfo', [v.path], { encoding: 'utf8' })
      af = (out.match(/estimated duration:\s*([\d.]+)/) || [, '?'])[1]
    } catch (e) { af = 'FAIL' }
    console.log(`  ${v.name.padEnd(26)} Safari=${String(dur).padEnd(22)} AVFoundation=${af}`)
  }
} finally {
  server.close()
}
