import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [basicSsl(), vue()],
  base: '/Teleprompter/',
  server: {
    proxy: {
      // 开发机上传接口：node scripts/upload-server.mjs
      '/upload': 'http://localhost:5180',
    },
  },
})
