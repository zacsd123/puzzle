import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, createReadStream, statSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { MAX_GRID, MAX_IMAGE_BYTES, MAX_PIECES, MIN_GRID } from '../shared/protocol'
import type { CreateRoomResponse } from '../shared/protocol'
import { RoomManager } from './rooms'
import type { Room } from './rooms'

// 호스팅 환경이 PORT를 주는 경우를 지원하되, PUZZLE_PORT가 있으면 그것을 우선한다.
const PORT = Number(process.env.PUZZLE_PORT ?? process.env.PORT ?? 3001)
// 프론트를 다른 도메인에 분리 배포할 때, 그 도메인을 여기 지정한다. (쉼표로 여러 개, 기본은 전체 허용)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*'
const DEV_CLIENT_PORT = 5199 // vite.config.ts의 개발용 화면 포트
const IS_PROD = process.env.NODE_ENV === 'production'
const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url))

const rooms = new RoomManager()
setInterval(() => rooms.sweep(), 60_000).unref()

// ---------- 유틸 ----------
function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/** 업로드된 바이트가 실제로 jpeg/png/webp인지 매직 넘버로 확인한다. */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length > 12) {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      return 'image/webp'
    }
  }
  return null
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > limit) {
      req.resume()
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let tooBig = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) tooBig = true
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)))
    req.on('error', () => resolve(null))
  })
}

// 방 생성 남용 방지: IP당 분당 10회
const createLog = new Map<string, number[]>()
function allowCreate(ip: string): boolean {
  const now = Date.now()
  const recent = (createLog.get(ip) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= 10) {
    createLog.set(ip, recent)
    return false
  }
  recent.push(now)
  createLog.set(ip, recent)
  return true
}

function intParam(url: URL, key: string): number {
  const n = Number(url.searchParams.get(key))
  return Number.isInteger(n) ? n : NaN
}

function setCors(req: IncomingMessage, res: ServerResponse) {
  const allowed = ALLOWED_ORIGIN.split(',').map((s) => s.trim())
  const origin = req.headers.origin
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN === '*' ? '*' : origin && allowed.includes(origin) ? origin : allowed[0])
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

// ---------- API ----------
async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const parts = url.pathname.split('/').filter(Boolean) // ['api', 'rooms', ...]

  // POST /api/rooms?cols=&rows=&w=&h=   (body: 이미지 바이트)
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'rooms') {
    const ip = req.socket.remoteAddress ?? 'unknown'
    if (!allowCreate(ip)) return json(res, 429, { error: '잠시 후 다시 시도해 주세요.' })

    const cols = intParam(url, 'cols')
    const rows = intParam(url, 'rows')
    const w = intParam(url, 'w')
    const h = intParam(url, 'h')
    const gridOk =
      cols >= MIN_GRID && cols <= MAX_GRID && rows >= MIN_GRID && rows <= MAX_GRID && cols * rows <= MAX_PIECES
    const sizeOk = w >= 100 && w <= 4096 && h >= 100 && h <= 4096
    if (!gridOk || !sizeOk) return json(res, 400, { error: '잘못된 퍼즐 설정이에요.' })

    const body = await readBody(req, MAX_IMAGE_BYTES)
    if (!body) return json(res, 413, { error: '이미지가 너무 커요. (최대 8MB)' })
    const mime = sniffImageMime(body)
    if (!mime) return json(res, 415, { error: 'JPG, PNG, WEBP 이미지만 올릴 수 있어요.' })

    const room = rooms.create({ cols, rows, imageWidth: w, imageHeight: h, image: body, mime })
    if (!room) return json(res, 503, { error: '지금은 방을 더 만들 수 없어요.' })
    const out: CreateRoomResponse = { roomId: room.id }
    return json(res, 201, out)
  }

  // GET /api/rooms/:id
  if (req.method === 'GET' && parts.length === 3 && parts[1] === 'rooms') {
    const room = rooms.get(parts[2])
    if (!room) return json(res, 404, { error: '방을 찾을 수 없어요.' })
    return json(res, 200, room.summary())
  }

  // GET /api/rooms/:id/image
  if (req.method === 'GET' && parts.length === 4 && parts[1] === 'rooms' && parts[3] === 'image') {
    const room = rooms.get(parts[2])
    if (!room) return json(res, 404, { error: '방을 찾을 수 없어요.' })
    res.writeHead(200, {
      'Content-Type': room.mime,
      'Content-Length': room.image.length,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(room.image)
    return
  }

  json(res, 404, { error: 'Not found' })
}

// ---------- 정적 파일 (프로덕션: 빌드된 React 앱) ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  let rel: string
  try {
    rel = decodeURIComponent(url.pathname)
  } catch {
    res.writeHead(400).end()
    return
  }
  let file = path.join(DIST_DIR, rel)
  // 경로 탈출 방지
  if (file !== DIST_DIR && !file.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(403).end()
    return
  }
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile()
  // 파일이 없으면 SPA 라우팅을 위해 index.html로 보낸다.
  if (!isFile(file)) file = path.join(DIST_DIR, 'index.html')
  if (!isFile(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('빌드된 화면이 없어요. 먼저 `npm run build`를 실행해 주세요.')
    return
  }
  const ext = path.extname(file).toLowerCase()
  const immutable = file.includes(`${path.sep}assets${path.sep}`)
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (req.method === 'HEAD') res.end()
  else createReadStream(file).pipe(res)
}

// ---------- HTTP 서버 ----------
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('ok')
  } else if (url.pathname.startsWith('/api/')) {
    setCors(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    handleApi(req, res, url).catch((err) => {
      console.error(err)
      if (!res.headersSent) json(res, 500, { error: '서버 오류' })
    })
  } else if (IS_PROD) {
    serveStatic(req, res, url)
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`개발 모드: 화면은 http://localhost:${DEV_CLIENT_PORT} 에서 열어 주세요.`)
  }
})

// ---------- WebSocket ----------
interface AliveSocket extends WebSocket {
  isAlive: boolean
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 })

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (pathname !== '/ws') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (rawWs) => {
  const ws = rawWs as AliveSocket
  ws.isAlive = true
  ws.on('pong', () => {
    ws.isAlive = true
  })

  let room: Room | null = null
  let player: ReturnType<Room['join']> = null
  const joinTimeout = setTimeout(() => {
    if (!player) ws.close(4000, 'join timeout')
  }, 10_000)

  // 연결당 초당 메시지 수 제한
  let windowStart = Date.now()
  let count = 0

  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    const now = Date.now()
    if (now - windowStart > 1000) {
      windowStart = now
      count = 0
    }
    if (++count > 240) return

    let msg: unknown
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }

    if (!player) {
      if (typeof msg !== 'object' || msg === null) return
      const m = msg as Record<string, unknown>
      if (m.t !== 'join' || typeof m.roomId !== 'string') return
      const target = rooms.get(m.roomId)
      if (!target) {
        ws.send(JSON.stringify({ t: 'error', message: '방을 찾을 수 없어요.' }))
        ws.close(4004, 'room not found')
        return
      }
      const joined = target.join(ws, m.name)
      if (!joined) {
        ws.close(4003, 'join rejected')
        return
      }
      room = target
      player = joined
      clearTimeout(joinTimeout)
      return
    }
    room?.handle(player, msg)
  })

  ws.on('close', () => {
    clearTimeout(joinTimeout)
    if (room && player) room.leave(player)
  })
  ws.on('error', () => ws.terminate())
})

// 끊긴 연결 정리 (공유기/터널이 조용히 끊는 경우 대비)
setInterval(() => {
  for (const client of wss.clients) {
    const ws = client as AliveSocket
    if (!ws.isAlive) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    ws.ping()
  }
}, 30_000).unref()

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n퍼즐 파티 서버 시작 (포트 ${PORT}, ${IS_PROD ? '프로덕션' : '개발'} 모드)`)
  const base = IS_PROD ? PORT : DEV_CLIENT_PORT
  console.log(`  이 컴퓨터:  http://localhost:${base}`)
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        console.log(`  같은 와이파이: http://${addr.address}:${base}`)
      }
    }
  }
  if (IS_PROD && !existsSync(path.join(DIST_DIR, 'index.html'))) {
    console.warn('\n⚠ dist/가 없어요. `npm run build`를 먼저 실행해 주세요.')
  }
})
