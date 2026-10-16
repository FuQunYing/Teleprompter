
<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'

const script = ref('')
const speed = ref(35) // 每秒滚动像素
const videoEl = ref<HTMLVideoElement | null>(null)
const promptEl = ref<HTMLElement | null>(null)

const cameraReady = ref(false)
const recording = ref(false)
const paused = ref(false)
const error = ref('')
const videoUrl = ref('')

let stream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let chunks: BlobPart[] = []
let rafId = 0
let lastTime = 0
let scrollOffset = 0

const speedLabel = computed(() => `${speed.value} px/s`)

async function openCamera() {
  error.value = ''

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头访问，请使用最新版 iPhone Safari 和 HTTPS。')
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: 'user',
        width: { ideal: 1080 },
        height: { ideal: 1920 },
      },
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

function startRecording() {
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

  try {
    chunks = []

    const mimeType = [
      'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
      'video/mp4',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ].find(type => MediaRecorder.isTypeSupported(type))

    recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)

    recorder.ondataavailable = event => {
      if (event.data.size > 0) chunks.push(event.data)
    }

    recorder.onstop = () => {
      const type = recorder?.mimeType || chunks[0]?.type || 'video/mp4'
      const blob = new Blob(chunks, { type })

      if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
      videoUrl.value = URL.createObjectURL(blob)

      recording.value = false
      paused.value = false
      cancelAnimationFrame(rafId)
    }

    recorder.start(1000)
    recording.value = true
    paused.value = false
    scrollOffset = 0

    if (promptEl.value) promptEl.value.scrollTop = 0
    startScroll()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '启动录像失败'
  }
}

function togglePause() {
  if (!recorder || !recording.value) return

  if (paused.value) {
    if (recorder.state === 'paused') recorder.resume()
    paused.value = false
    startScroll()
  } else {
    if (recorder.state === 'recording') recorder.pause()
    paused.value = true
    cancelAnimationFrame(rafId)
  }
}

function stopRecording() {
  cancelAnimationFrame(rafId)

  if (recorder && recorder.state !== 'inactive') {
    recorder.stop()
  } else {
    recording.value = false
  }
}

function resetPrompt() {
  if (recording.value) return
  scrollOffset = 0
  lastTime = 0
  if (promptEl.value) promptEl.value.scrollTop = 0
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
  stream?.getTracks().forEach(track => track.stop())
  if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
})
</script>

<template>
  <main class="app">
    <h1>我的提词器</h1>

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
      <span v-if="recording" class="rec">● REC</span>
    </section>

    <label class="field-label">口播台词</label>
    <textarea
        v-model="script"
        :disabled="recording"
        placeholder="输入或粘贴你的台词……"
        rows="5"
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

    <p v-if="error" class="error">{{ error }}</p>

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
      <video :src="videoUrl" controls playsinline class="result-video" />
      <button @click="saveVideo">导出 / 保存视频</button>
    </section>
  </main>
</template>
