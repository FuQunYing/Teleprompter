// 极简静态服务器（给 Safari 探测用），支持 Range 请求
// 用法: node scripts/static-server.mjs [端口] [目录]
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
const port = Number(process.argv[2] || 8080)
const root = process.argv[3] || 'public'
const types = { '.html': 'text/html', '.mp4': 'video/mp4', '.webm': 'video/webm', '.js': 'text/javascript' }
createServer((req, res) => {
  const p = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\//, ''))
  if (!existsSync(p) || !statSync(p).isFile()) { res.writeHead(404).end('nope'); return }
  const size = statSync(p).size
  const type = types[extname(p)] || 'application/octet-stream'
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    const start = m && m[1] ? Number(m[1]) : 0
    const end = m && m[2] ? Number(m[2]) : size - 1
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    })
    res.end(readFileSync(p).slice(start, end + 1))
    return
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size })
  res.end(readFileSync(p))
}).listen(port, () => console.log(`静态服务: http://localhost:${port}/ (${root})`))
