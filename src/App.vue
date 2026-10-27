
<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import { fixMp4Duration } from './mp4Duration'

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

const CANVAS_W = 720
const CANVAS_H = 1280
const TARGET_FPS = 30
const FRAME_INTERVAL = 1000 / TARGET_FPS

let stream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let canvasStream: MediaStream | null = null
let canvasTrack: CanvasCaptureMediaStreamTrack | null = null
let audioCtx: AudioContext | null = null
let canvasCtx: CanvasRenderingContext2D | null = null
let useRequestFrame = false
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

/**
 * 麦克风音轨通过 AudioContext 重新生成一路。
 * 直接把 live 音轨塞进 canvas 流时，音频与画面的时钟基准不一致，
 * Safari 混流后 mp4 的 media duration 会算错。
 */
async function createAudioTrack(): Promise<MediaStreamTrack | null> {
  const micTracks = stream?.getAudioTracks() ?? []
  if (!micTracks.length) return null

  const AudioCtor = window.AudioContext ?? (window as any).webkitAudioContext
  if (!AudioCtor) return micTracks[0]

  try {
    const ctx = new AudioCtor() as AudioContext
    await ctx.resume()
    const source = ctx.createMediaStreamSource(new MediaStream(micTracks))
    const dest = ctx.createMediaStreamDestination()
    source.connect(dest)
    audioCtx = ctx
    return dest.stream.getAudioTracks()[0] ?? null
  } catch (e) {
    console.warn('音频重采样失败，退回原始音轨', e)
    return micTracks[0]
  }
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
    if (useRequestFrame && canvasTrack) canvasTrack.requestFrame()
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
    // captureStream(0) + requestFrame() = 严格恒定帧率；
    // 老 Safari 不支持 requestFrame 时退回 captureStream(30)。
    const audioTrack = await createAudioTrack()

    const canRequestFrame =
      typeof CanvasCaptureMediaStreamTrack !== 'undefined' &&
      typeof CanvasCaptureMediaStreamTrack.prototype.requestFrame === 'function'

    useRequestFrame = canRequestFrame
    canvasStream = canRequestFrame ? canvas.captureStream(0) : canvas.captureStream(TARGET_FPS)
    canvasTrack = (canvasStream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack) ?? null

    if (audioTrack) canvasStream.addTrack(audioTrack)

    const mimeType = [
      'video/mp4;codecs="avc1.42E028,mp4a.40.2"',
      'video/mp4',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ].find(type => MediaRecorder.isTypeSupported(type))

    const rec = mimeType
      ? new MediaRecorder(canvasStream, { mimeType })
      : new MediaRecorder(canvasStream)

    const localChunks: Blob[] = []

    rec.ondataavailable = event => {
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

      // Safari 的 fragmented mp4 里 moov 的 duration 常是错的，
      // 这里按实际采样时间重算并回写，修正相册里的时长与进度条。
      try {
        const fixed = await fixMp4Duration(blob, elapsed)
        blob = fixed.blob
        if (fixed.changed) {
          const stored = fixed.analysis.storedMovieDuration / fixed.analysis.movieTimescale
          durationNote.value = Math.abs(stored - fixed.targetDuration) > 0.05
            ? `已修正容器时长（原始标注 ${stored.toFixed(1)}s → ${fixed.targetDuration.toFixed(1)}s）`
            : `已修正容器时长字段（${fixed.targetDuration.toFixed(1)}s）`
        }
      } catch (e) {
        console.warn('修正 mp4 时长失败', e)
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
      if (resultDuration.value > 0) {
        durationNote.value = durationNote.value
          ? `${durationNote.value} · 成片时长 ${resultDuration.value.toFixed(1)} 秒`
          : `成片时长 ${resultDuration.value.toFixed(1)} 秒`
      }
    }

    recorder = rec
    recordFailed = false
    // 不带 timeslice：让 Safari 走常规 muxer 路径，产出带完整 moov 的 mp4
    rec.start()

    recording.value = true
    paused.value = false
    recordStartAt = performance.now()
    pausedAt = 0
    pausedTotal = 0
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
    canvasStream.getTracks().forEach(t => t.stop())
    canvasStream = null
  }
  canvasTrack = null
  useRequestFrame = false
  canvasCtx = null
  if (audioCtx) {
    audioCtx.close().catch(() => {})
    audioCtx = null
  }
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
    if (recorder.state === 'paused') recorder.resume()
    paused.value = false
    pausedTotal += performance.now() - pausedAt
    lastFrameAt = 0
    startScroll()
    startRecordingTimer()
  } else {
    if (recorder.state === 'recording') recorder.pause()
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
      <video :src="videoUrl" controls playsinline class="result-video" />
      <button @click="saveVideo">导出 / 保存视频</button>
    </section>
  </main>
</template>
