// 接收 App 上传的录像，保存到 uploads/ 目录，方便在电脑上分析。
// 用法：node scripts/upload-server.mjs
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'

const DIR = new URL('../uploads/', import.meta.url).pathname
const PORT = Number(process.env.UPLOAD_PORT || 5180)

mkdirSync(DIR, { recursive: true })

createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    return res.end()
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end('method not allowed')
    return
  }

  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    // 头部：文件名(utf8 长度) + 内容
    const nameLen = body.readUInt32BE(0)
    const name = body.slice(4, 4 + nameLen).toString('utf8')
    const data = body.slice(4 + nameLen)
    const safe = name.replace(/[^\w.\-]/g, '_')
    const path = `${DIR}${Date.now()}-${safe}`
    writeFileSync(path, data)
    console.log(`收到 ${name} (${(data.length / 1024 / 1024).toFixed(2)} MB) → ${path}`)
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' })
    res.end(path)
  })
}).listen(PORT, () => {
  console.log(`上传服务已启动: http://localhost:${PORT}/upload  →  ${DIR}`)
})
