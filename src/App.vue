
<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import { fixMp4Duration, dumpMp4Structure } from './mp4Duration'
import { toProgressiveMp4 } from './mp4Progressive'

const script = ref('')
const speed = ref(35) // 每秒滚动像素
const videoEl = ref<HTMLVideoElement | null>(null)
const promptEl = ref<HTMLElement | null>(null)

const cameraReady = ref(false)
const recording = ref(false)
const paused = ref(false)
const error = ref('')
const videoUrl = ref('')
const showSettings = ref(false)
const recordingSeconds = ref(0)
const resultDuration = ref(0) // 成片真实时长（秒）
const durationNote = ref('')
const dumpNote = ref('')

const CANVAS_W = 1080
const CANVAS_H = 1920
const TARGET_FPS = 30
const VIDEO_BITRATE = 4_000_000
const FRAME_INTERVAL = 1000 / TARGET_FPS

let stream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let canvasStream: MediaStream | null = null
let canvasCtx: CanvasRenderingContext2D | null = null
let rafId = 0
let drawRafId = 0
let lastTime = 0
let lastFrameAt = 0
let scrollOffset = 0
let recordingTimerId = 0
let recordStartAt = 0
let pausedAt = 0
let pausedTotal = 0
let recordFailed = false

// ---- 录制诊断：记录摄像头轨、录像器、页面可见性的异常事件，以及画布/编码是否还在出帧 ----
let diagLog: string[] = []
let camLog: string[] = []
let recordCount = 0
let framesDrawn = 0
let chunkCount = 0
let diagStop: (() => void) | null = null

function diag(msg: string) {
  const t = recordStartAt ? (performance.now() - recordStartAt) / 1000 : 0
  diagLog.push(`${t.toFixed(1)}s ${msg}`)
}

function watchDiag(rec: MediaRecorder, video: HTMLVideoElement, tracks: MediaStreamTrack[]) {
  const off: (() => void)[] = []
  const on = (target: EventTarget, name: string, label: string) => {
    const fn = () => diag(label)
    target.addEventListener(name, fn)
    off.push(() => target.removeEventListener(name, fn))
  }
  tracks.forEach(t => {
    on(t, 'mute', `${t.kind}轨 mute`)
    on(t, 'unmute', `${t.kind}轨 unmute`)
    on(t, 'ended', `${t.kind}轨 ended`)
  })
  ;(['pause', 'stalled', 'waiting', 'suspend', 'emptied'] as const).forEach(n => on(video, n, `预览 ${n}`))
  on(rec, 'pause', '录像器 pause')
  on(rec, 'resume', '录像器 resume')
  const visibility = () => diag(`页面 ${document.visibilityState}`)
  document.addEventListener('visibilitychange', visibility)
  off.push(() => document.removeEventListener('visibilitychange', visibility))
  return () => off.forEach(fn => fn())
}

const speedLabel = computed(() => `${speed.value} px/s`)

async function openCamera() {
  error.value = ''

  try {
    // Lock to portrait so iOS Safari has a chance of returning a portrait
    // MediaStream. Webkit doesn't honor this reliably, but it's worth a try.
    if (screen.orientation?.lock) {
      try {
        await screen.orientation.lock('portrait')
      } catch {
        // user denied or unsupported — fall through to landscape stream + canvas
      }
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头访问，请使用最新版 iPhone Safari 和 HTTPS。')
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: 'user',
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 30 },
      }
    })

    if (videoEl.value) {
      videoEl.value.srcObject = stream
      await videoEl.value.play()
    }

    // 诊断：预览期间摄像头/麦克风轨有没有被系统静音或结束
    camLog = []
    const openedAt = performance.now()
    stream.getTracks().forEach(t => {
      ;(['mute', 'unmute', 'ended'] as const).forEach(name => {
        t.addEventListener(name, () => {
          camLog.push(`预览${((performance.now() - openedAt) / 1000).toFixed(0)}s ${t.kind} ${name}`)
        })
      })
    })

    cameraReady.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法打开摄像头'
  }
}

function animateScroll(now: number) {
  if (!recording.value || paused.value) {
    rafId = 0
    lastTime = 0
    return
  }

  if (lastTime !== 0 && promptEl.value) {
    const delta = Math.min((now - lastTime) / 1000, 0.1)

    scrollOffset += speed.value * delta

    const el = promptEl.value
    const maxScroll = el.scrollHeight - el.clientHeight

    el.scrollTop = Math.min(scrollOffset, maxScroll)

    if (el.scrollTop >= maxScroll) {
      rafId = 0
      return
    }
  }

  lastTime = now
  rafId = requestAnimationFrame(animateScroll)
}

function startScroll() {
  if (rafId) cancelAnimationFrame(rafId)

  lastTime = 0
  rafId = requestAnimationFrame(animateScroll)
}

function drawFrame() {
  const video = videoEl.value
  if (!video) return

  const ctx = canvasCtx
  if (!ctx) return

  const vw = video.videoWidth || 1920
  const vh = video.videoHeight || 1080

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

  // Fit (letterbox): scale to fit canvas without cropping.
  const scale = Math.min(CANVAS_W / vw, CANVAS_H / vh)
  const dw = vw * scale
  const dh = vh * scale

  ctx.save()
  ctx.translate(CANVAS_W / 2, CANVAS_H / 2)
  ctx.scale(-1, 1)
  ctx.drawImage(video, -dw / 2, -dh / 2, dw, dh)
  ctx.restore()
  framesDrawn++
}

function startDrawLoop() {
  if (drawRafId) cancelAnimationFrame(drawRafId)
  lastFrameAt = 0

  const draw = (now: number) => {
    if (!recording.value) {
      drawRafId = 0
      return
    }
    drawRafId = requestAnimationFrame(draw)

    if (paused.value) return
    // 固定帧率：按 TARGET_FPS 节流，避免产出 VFR（可变帧率）视频
    if (now - lastFrameAt < FRAME_INTERVAL) return
    lastFrameAt = now

    drawFrame()
  }

  drawRafId = requestAnimationFrame(draw)
}

async function startRecording() {
  if (!stream) {
    error.value = '请先开启摄像头'
    return
  }

  if (!script.value.trim()) {
    error.value = '请先输入台词'
    return
  }

  if (!window.MediaRecorder) {
    error.value = '当前浏览器不支持网页录像，请尝试更新 iOS。'
    return
  }

  const video = videoEl.value
  if (!video) return

  error.value = ''
  durationNote.value = ''

  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_W
  canvas.height = CANVAS_H
  canvasCtx = canvas.getContext('2d')

  try {
    // 固定帧率采集（不要用 captureStream(0)+requestFrame：
    // iOS Safari 上 requestFrame 不可靠，会只录到一两帧）
    canvasStream = canvas.captureStream(TARGET_FPS)

    // 直接用麦克风原始音轨（不要绕 AudioContext：
    // 重新生成的音轨时间戳基准不同，会让 mp4 音轨时间轴错乱）
    const audioTrack = stream.getAudioTracks()[0]
    if (audioTrack) canvasStream.addTrack(audioTrack)

    const mimeType = [
      'video/mp4;codecs="avc1.42E028,mp4a.40.2"',
      'video/mp4',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ].find(type => MediaRecorder.isTypeSupported(type))

    // 实验：默认码率约 14 Mbps，某台手机上录到 ~20MB 左右视频就不再出帧。
    // 先只降码率到 4 Mbps，看停的时间会不会推迟，用来区分是「数据量」还是「时间」相关。
    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(canvasStream, mimeType
        ? { mimeType, videoBitsPerSecond: VIDEO_BITRATE }
        : { videoBitsPerSecond: VIDEO_BITRATE })
    } catch {
      rec = mimeType
        ? new MediaRecorder(canvasStream, { mimeType })
        : new MediaRecorder(canvasStream)
    }

    const localChunks: Blob[] = []

    diagLog = []
    framesDrawn = 0
    chunkCount = 0
    diagStop?.()
    diagStop = watchDiag(rec, video, [
      ...stream.getTracks(),
      ...canvasStream.getVideoTracks(),
    ])

    rec.ondataavailable = event => {
      chunkCount++
      if (event.data.size > 0) localChunks.push(event.data)
    }

    rec.onerror = (event: Event) => {
      const err = (event as any).error
      error.value = `录制出错：${err?.message ?? '未知错误'}`
      recordFailed = true
      recording.value = false
      paused.value = false
      stopRecordingTimer()
      cleanupCapture()
    }

    rec.onstop = async () => {
      if (recordFailed) {
        recordFailed = false
        cleanupCapture()
        return
      }

      const type = rec.mimeType || localChunks[0]?.type || 'video/mp4'
      let blob = new Blob(localChunks, { type })

      // 实际录制时长（秒），用于容器时间戳不可信时兜底
      const elapsed = Math.max(0, (performance.now() - recordStartAt - pausedTotal) / 1000)

      // 1) 修正容器时长：Safari 写出来的 mp4 里 mvhd/mdhd/tkhd 的 duration 是 0 或错的
      let missingAudio = false
      try {
        const fixed = await fixMp4Duration(blob, elapsed)
        blob = fixed.blob
        missingAudio = !fixed.analysis.tracks.some(t => t.kind === 'soun' && t.sampleCount > 0)
        if (isDev) {
          const stored = fixed.analysis.storedMovieDuration / fixed.analysis.movieTimescale
          const parts = [`录制 ${elapsed.toFixed(1)}s`]
          parts.push(fixed.changed ? `容器时长已修正 → ${fixed.targetDuration.toFixed(1)}s` : '容器时长未改动')
          parts.push(`原始标注 ${stored.toFixed(1)}s`)
          parts.push(`录像器原始轨道：${fixed.analysis.tracks.map(t => `${t.kind} ${t.sampleCount}样本`).join(' / ') || '无'}`)
          if (missingAudio) parts.push('⚠ 录像器没有写入任何音频')
          if (fixed.report) parts.push(fixed.report)
          durationNote.value = parts.join(' ｜ ')
        }
      } catch (e) {
        console.warn('修正 mp4 时长失败', e)
      }

      // 2) fragmented mp4 → progressive mp4。
      //    WebKit（Safari / iOS Safari）对 fragmented mp4 的时长计算会把音视频两条轨
      //    相加，导致时长翻倍（10.5 秒的片子显示成 21 秒），进度条和剪辑都错。
      //    转成 progressive 后走标准的 stts/stsz 路径，时长才正确。
      try {
        const prog = await toProgressiveMp4(blob)
        if (prog.changed) {
          blob = prog.blob
          if (isDev) {
            const detail = prog.tracks.map(t => {
              const keys = t.kind === 'vide' && t.syncSamples ? ` ${t.syncSamples}个关键帧` : ''
              return `${t.kind} ${t.samples}帧${keys} ${t.duration.toFixed(1)}s`
            }).join(' / ')
            durationNote.value = `${durationNote.value} ｜ 已转为标准 mp4（${detail}）`
          }
        }
      } catch (e) {
        console.warn('转换 mp4 失败', e)
      }

      if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
      videoUrl.value = URL.createObjectURL(blob)

      recording.value = false
      paused.value = false
      cancelAnimationFrame(rafId)
      stopRecordingTimer()
      cleanupCapture()

      const probed = await probeDuration(videoUrl.value)
      resultDuration.value = Number.isFinite(probed) ? probed : 0
      if (isDev) {
        try {
          dumpNote.value = await dumpMp4Structure(blob)
        } catch (e) {
          console.warn('导出 mp4 结构失败', e)
        }
      }
      if (resultDuration.value > 0) {
        durationNote.value = durationNote.value
          ? `${durationNote.value} · 成片时长 ${resultDuration.value.toFixed(1)} 秒`
          : `成片时长 ${resultDuration.value.toFixed(1)} 秒`
      }
      if (!isDev && missingAudio) {
        durationNote.value = `${durationNote.value ? `${durationNote.value} ｜ ` : ''}⚠ 本次录像未录到声音，请检查麦克风是否被占用`
      }

      // 诊断：停止时画布一共画了多少帧、录像器吐了几次数据、期间出过什么事件
      diag(`停止：画布共画 ${framesDrawn} 帧，录像器数据块 ${chunkCount} 个`)
      diagStop?.()
      diagStop = null
      if (isDev) {
        durationNote.value = `${durationNote.value}\n【诊断】${diagLog.join('；')}`
      }
    }

    recorder = rec
    recordFailed = false
    // 每 1000ms 刷出一个分片：避免 Safari 把整场音视频一直憋在单个内存缓冲里（约 15~20MB 后停止收视频帧），
    // 停止录制后由 toProgressiveMp4 把所有 moof+mdat 分片合并成标准 mp4。
    rec.start(1000)

    recording.value = true
    paused.value = false
    recordStartAt = performance.now()
    pausedAt = 0
    pausedTotal = 0

    // 诊断：开录那一刻，麦克风/摄像头轨是不是活的、有没有被静音
    const describe = (t: MediaStreamTrack) =>
      `${t.kind}[${t.readyState}${t.muted ? ',muted' : ''}${t.enabled ? '' : ',disabled'}]`
    recordCount++
    diag(`本页第 ${recordCount} 次录制；预览期事件：${camLog.join('、') || '无'}`)
    diag(`摄像头流 ${stream.getTracks().map(describe).join(' ') || '无轨'}；录像流 ${canvasStream?.getTracks().map(describe).join(' ') || '无轨'}；类型 ${rec.mimeType}；视频码率 ${rec.videoBitsPerSecond}；画布 ${CANVAS_W}x${CANVAS_H}`)
    scrollOffset = 0
    recordingSeconds.value = 0
    startRecordingTimer()

    if (promptEl.value) promptEl.value.scrollTop = 0
    startDrawLoop()
    startScroll()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '启动录像失败'
    cleanupCapture()
  }
}

function cleanupCapture() {
  if (drawRafId) {
    cancelAnimationFrame(drawRafId)
    drawRafId = 0
  }
  if (canvasStream) {
    // 只停画布自己的视频轨。音轨是从摄像头流里借来的同一条麦克风轨，
    // 停掉它会让同一页面里下一次录制没有声音。
    canvasStream.getVideoTracks().forEach(t => t.stop())
    canvasStream.getAudioTracks().forEach(t => canvasStream?.removeTrack(t))
    canvasStream = null
  }
  canvasCtx = null
}

function probeDuration(url: string): Promise<number> {
  return new Promise(resolve => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => resolve(v.duration)
    v.onerror = () => resolve(NaN)
    v.src = url
  })
}

function togglePause() {
  if (!recorder || !recording.value) return

  if (paused.value) {
    if (recorder.state === 'paused') {
      try {
        recorder.resume()
      } catch (e) {
        console.warn('resume 失败', e)
      }
    }
    paused.value = false
    pausedTotal += performance.now() - pausedAt
    lastFrameAt = 0
    startScroll()
    startRecordingTimer()
  } else {
    // 必须确认 recorder 真的暂停了：否则录像仍在继续，
    // 而我们却把这段时间算作「暂停」，会导致实际录制时长算错。
    let actuallyPaused = false
    const stateBefore: string = recorder.state
    try {
      if (stateBefore === 'recording') recorder.pause()
    } catch (e) {
      console.warn('pause 失败', e)
    }
    const stateAfter: string = recorder.state
    actuallyPaused = stateAfter === 'paused'

    if (!actuallyPaused) {
      error.value = '当前浏览器不支持暂停录制'
      return
    }

    paused.value = true
    pausedAt = performance.now()
    cancelAnimationFrame(rafId)
    stopRecordingTimer()
  }
}

function startRecordingTimer() {
  stopRecordingTimer()
  recordingTimerId = window.setInterval(() => {
    recordingSeconds.value++
    if (recordingSeconds.value % 4 === 0) {
      const v = videoEl.value
      diag(`画布已画 ${framesDrawn} 帧，预览 t=${v ? v.currentTime.toFixed(1) : '?'} ${v?.paused ? '(paused)' : ''}`)
    }
  }, 1000)
}

function stopRecordingTimer() {
  if (recordingTimerId) {
    clearInterval(recordingTimerId)
    recordingTimerId = 0
  }
}

function stopRecording() {
  cancelAnimationFrame(rafId)

  if (recorder && recorder.state !== 'inactive') {
    recorder.stop()
  } else {
    recording.value = false
    cleanupCapture()
  }
}

function resetPrompt() {
  if (recording.value) return
  scrollOffset = 0
  lastTime = 0
  if (promptEl.value) promptEl.value.scrollTop = 0
}

function openSettings() {
  if (recording.value) return
  showSettings.value = true
}

function closeSettings() {
  showSettings.value = false
}

// 排查用：只有 `npm run dev` 的开发服务器带 /upload 转发，线上页面没有这个接口，所以只在开发环境显示按钮
const isDev = import.meta.env.DEV

async function copyDiagnostics() {
  const text = [
    durationNote.value,
    '',
    '--- mp4 结构 ---',
    dumpNote.value,
  ].join('\n')

  try {
    await navigator.clipboard.writeText(text)
    error.value = '诊断信息已复制到剪贴板'
  } catch {
    error.value = '复制失败，请手动截图上面的诊断行'
  }
}

async function uploadToDev() {
  if (!videoUrl.value) return
  error.value = '正在上传…'
  try {
    const blob = await (await fetch(videoUrl.value)).blob()
    const name = `teleprompter-${Date.now()}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`
    const nameBytes = new TextEncoder().encode(name)
    const header = new Uint8Array(4 + nameBytes.length)
    new DataView(header.buffer).setUint32(0, nameBytes.length)
    header.set(nameBytes, 4)
    const body = new Blob([header, blob])
    const res = await fetch('/upload', { method: 'POST', body })
    const text = await res.text()
    error.value = res.ok ? `已上传：${text}` : `上传失败：${text}`
  } catch (e) {
    error.value = `上传失败：${e instanceof Error ? e.message : e}`
  }
}

async function saveVideo() {
  if (!videoUrl.value) return

  const response = await fetch(videoUrl.value)
  const blob = await response.blob()
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm'
  const file = new File([blob], `teleprompter-${Date.now()}.${ext}`, {
    type: blob.type,
  })

  try {
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({
        files: [file],
        title: '提词器录像',
      })
      return
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return
  }

  const a = document.createElement('a')
  a.href = videoUrl.value
  a.download = file.name
  a.click()
}

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  stopRecordingTimer()
  cleanupCapture()
  stream?.getTracks().forEach(track => track.stop())
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
})
</script>

<template>
  <main class="app">
    <section class="camera">
      <video
          ref="videoEl"
          autoplay
          muted
          playsinline
          class="preview"
      />
      <div class="prompt" ref="promptEl">
        <p>{{ script || '请在下方输入你的台词' }}</p>
      </div>
        <span v-if="recording" class="rec">● REC {{ recordingSeconds }} 秒</span>
    </section>

    <p v-if="error" class="error">{{ error }}</p>

    <button
        class="fab"
        @click="openSettings"
        :disabled="recording"
        aria-label="设置"
    >
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round"
           stroke-linejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    </button>

    <div v-if="showSettings" class="modal-overlay" @click.self="closeSettings">
      <div class="modal-content">
        <button class="modal-close" @click="closeSettings" aria-label="关闭">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
               stroke="currentColor" stroke-width="2.4" stroke-linecap="round"
               stroke-linejoin="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <textarea
            v-model="script"
            :disabled="recording"
            placeholder="输入或粘贴你的台词……"
            rows="16"
        />

        <label class="field-label">
          滚动速度：{{ speedLabel }}
        </label>
        <input
            v-model.number="speed"
            type="range"
            min="10"
            max="100"
            step="5"
            :disabled="recording"
        />

        <button class="modal-save" @click="closeSettings">完成</button>
      </div>
    </div>

    <div class="actions">
      <button v-if="!cameraReady" @click="openCamera">
        开启摄像头
      </button>

      <template v-if="cameraReady">
        <button
            v-if="!recording"
            @click="startRecording"
        >
          开始录制
        </button>
        <button v-else @click="togglePause">
          {{ paused ? '继续录制' : '暂停' }}
        </button>
        <button v-if="recording" @click="stopRecording">
          结束录制
        </button>
      </template>

      <button v-if="!recording" @click="resetPrompt">
        重置提词
      </button>
    </div>

    <section v-if="videoUrl" class="result">
      <h2>录制完成</h2>
      <p v-if="durationNote" class="duration-note">{{ durationNote }}</p>
      <template v-if="isDev">
        <button class="ghost" @click="copyDiagnostics">复制诊断信息</button>
        <button class="ghost" @click="uploadToDev">上传到开发机（排查用）</button>
      </template>
      <video :src="videoUrl" controls playsinline class="result-video" />
      <button @click="saveVideo">导出 / 保存视频</button>
    </section>
  </main>
</template>
