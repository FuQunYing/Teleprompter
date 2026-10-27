// 用 macOS Safari（与 iOS Safari 同一套 WebKit）读取 mp4 的 <video>.duration。
// 做法：起一个静态服务器 → Safari 打开测试页 → 页面把 duration 写进 document.title
//      → AppleScript 读标签页标题。
//
// 用法：node scripts/probe-safari.mjs <文件1.mp4> [文件2.mp4 ...]
import { createServer } from 'node:http'
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('用法: node scripts/probe-safari.mjs <文件.mp4> ...')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'safariprobe-'))
const html = `<!doctype html><meta charset="utf-8"><title>loading</title>
<body style="font:28px monospace;padding:20px">读取中…<div id="out"></div>
<video id="v" style="width:300px"></video>
<script>
const v = document.getElementById('v')
v.src = new URLSearchParams(location.search).get('f')
const show = d => {
  document.title = 'DUR:' + d
  document.getElementById('out').textContent = 'duration = ' + d + ' 秒'
}
v.onloadedmetadata = () => show(v.duration)
v.onerror = () => { document.title = 'DUR:error'; document.getElementById('out').textContent = '加载失败' }
setTimeout(() => { if (document.title === 'loading') { document.title = 'DUR:timeout'; document.getElementById('out').textContent = '超时' } }, 15000)
</script>`

writeFileSync(join(dir, 'probe.html'), html)
for (const f of files) {
  const name = f.split('/').pop()
  writeFileSync(join(dir, name), readFileSync(f))
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = join(dir, decodeURIComponent(url.pathname).replace(/^\//, ''))
  if (!existsSync(path)) { res.writeHead(404).end('nope'); return }
  const data = readFileSync(path)
  const ext = path.endsWith('.html') ? 'text/html' : 'video/mp4'
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    const start = m && m[1] ? Number(m[1]) : 0
    const end = m && m[2] ? Number(m[2]) : data.length - 1
    res.writeHead(206, {
      'Content-Type': ext,
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    })
    res.end(data.slice(start, end + 1))
    return
  }
  res.writeHead(200, { 'Content-Type': ext, 'Accept-Ranges': 'bytes', 'Content-Length': data.length })
  res.end(data)
}).listen(8082)

async function safariDuration(file) {
  const name = file.split('/').pop()
  const url = `http://localhost:8082/probe.html?f=${encodeURIComponent(name)}`
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
  for (const f of files) {
    const dur = await safariDuration(f)
    console.log(`  Safari <video>.duration  ${f.split('/').pop().padEnd(38)} = ${dur}`)
  }
} finally {
  server.close()
}
