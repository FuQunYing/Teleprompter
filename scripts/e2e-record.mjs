// 用 headless Chrome + 假摄像头跑一遍真实的录制流程，验证时长与容器。
// 用法：node scripts/e2e-record.mjs
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const APP_URL = process.env.APP_URL || 'https://localhost:5173/Teleprompter/'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/teleprompter-e2e-profile',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run',
  '--ignore-certificate-errors',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' })

let ws
let nextId = 1
const pending = new Map()

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression, awaitPromise = true) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  })
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || JSON.stringify(res.exceptionDetails))
  }
  return res.result.value
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())
      const page = list.find(t => t.type === 'page')
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise(resolve => { ws.onopen = resolve })
        ws.onmessage = ev => {
          const msg = JSON.parse(ev.data)
          if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id)
            pending.delete(msg.id)
            msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
          }
        }
        return
      }
    } catch {}
    await sleep(250)
  }
  throw new Error('连不上 Chrome DevTools')
}

try {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')

  console.log('支持的 mp4 类型:')
  console.log(await evaluate(`JSON.stringify({
    mp4: MediaRecorder.isTypeSupported('video/mp4'),
    mp4Avc: MediaRecorder.isTypeSupported('video/mp4;codecs="avc1.42E028,mp4a.40.2"'),
    webm: MediaRecorder.isTypeSupported('video/webm'),
    requestFrame: typeof HTMLCanvasElement.prototype.captureStream === 'function'
      && 'requestFrame' in HTMLCanvasElement.prototype.captureStream.call(document.createElement('canvas')).getVideoTracks()[0]
  })`))

  await send('Page.navigate', { url: APP_URL })
  await sleep(2500)

  // 等应用渲染出来
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate(`document.querySelectorAll('button').length > 0`)
    if (ready) break
    await sleep(250)
  }
  console.log('页面按钮:', await evaluate(`JSON.stringify([...document.querySelectorAll('button')].map(b => b.textContent.trim()))`))

  // 打开摄像头 → 输入台词 → 开始录制 → 等 6 秒 → 停止
  await evaluate(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('开启摄像头'))
    btn.click()
    await new Promise(r => setTimeout(r, 1500))
    // 打开设置填台词
    document.querySelector('.fab').click()
    await new Promise(r => setTimeout(r, 300))
    const ta = document.querySelector('textarea')
    ta.value = '这是一段用于测试的台词。'.repeat(30)
    ta.dispatchEvent(new Event('input'))
    document.querySelector('.modal-save').click()
    await new Promise(r => setTimeout(r, 300))
    ;[...document.querySelectorAll('button')].find(b => b.textContent.includes('开始录制')).click()
  })()`)

  await sleep(4000)

  // 暂停 2 秒再继续：成片时长应排除暂停的 2 秒
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('暂停')).click()`)
  await sleep(2000)
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('继续录制')).click()`)
  await sleep(4000)

  const during = await evaluate(`JSON.stringify({
    rec: document.querySelector('.rec')?.textContent ?? null
  })`)
  console.log('录制中:', during)

  await evaluate(`(() => {
    [...document.querySelectorAll('button')].find(b => b.textContent.includes('结束录制')).click()
  })()`)

  await sleep(3000)

  const result = await evaluate(`(async () => {
    const v = document.querySelector('.result-video')
    if (!v) return JSON.stringify({ error: '没有生成结果视频' })
    await new Promise(resolve => {
      if (v.readyState >= 1) return resolve()
      v.onloadedmetadata = resolve
      setTimeout(resolve, 3000)
    })
    const note = document.querySelector('.duration-note')?.textContent ?? null
    return JSON.stringify({
      note,
      duration: v.duration,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      size: (await fetch(v.src)).blob().size,
    })
  })()`)
  console.log('结果:', result)

  // 把录出来的文件存到本地，供离线检查
  const b64 = await evaluate(`(async () => {
    const v = document.querySelector('.result-video')
    const buf = await (await fetch(v.src)).arrayBuffer()
    let s = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s)
  })()`)
  const { writeFileSync } = await import('node:fs')
  writeFileSync('/tmp/teleprompter-e2e.mp4', Buffer.from(b64, 'base64'))
  console.log('已保存 /tmp/teleprompter-e2e.mp4')

  // 顺便验证「上传到开发机」这条链路
  const uploaded = await evaluate(`(async () => {
    const blob = await (await fetch(document.querySelector('.result-video').src)).blob()
    const name = 'e2e-test.mp4'
    const nb = new TextEncoder().encode(name)
    const header = new Uint8Array(4 + nb.length)
    new DataView(header.buffer).setUint32(0, nb.length)
    header.set(nb, 4)
    const res = await fetch('/upload', { method: 'POST', body: new Blob([header, blob]) })
    return res.status + ' ' + await res.text()
  })()`)
  console.log('上传测试:', uploaded)
} finally {
  try { ws?.close() } catch {}
  chrome.kill()
}
