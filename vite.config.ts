import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 개발 중에는 Vite(5199)가 /api, /ws 요청을 Node 서버(3001)로 넘겨준다.
// - 'localhost'는 IPv6(::1)로 먼저 풀릴 수 있어 다른 프로그램에 연결될 수 있으니 127.0.0.1로 고정한다.
// - 서버 포트는 PUZZLE_PORT로만 바꾼다. (PORT는 호스팅 환경/다른 도구가 설정하는 경우가 많아 개발에서는 쓰지 않음)
const SERVER_PORT = Number(process.env.PUZZLE_PORT ?? 3001)

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5199,
    strictPort: true, // 이미 쓰는 포트면 조용히 다른 포트로 가지 않고 바로 알려준다.
    proxy: {
      '/api': `http://127.0.0.1:${SERVER_PORT}`,
      '/ws': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
    },
  },
})
