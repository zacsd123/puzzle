import type {
  ClientMessage,
  PieceState,
  PlayerInfo,
  PuzzleConfig,
  ServerMessage,
} from '../../shared/protocol'
import { apiUrl, wsUrl } from '../lib/config'
import { buildGeometry, renderPieceBitmaps } from './jigsaw'
import type { PieceGeometry } from './jigsaw'

/** 화면에 그릴 조각. (x, y)가 부드럽게 (tx, ty)를 따라간다. */
export interface ClientPiece extends PieceState {
  tx: number
  ty: number
}

export interface ClientPlayer {
  info: PlayerInfo
  x: number
  y: number
  tx: number
  ty: number
  hasCursor: boolean
  lastSeen: number
}

export interface PuzzleAssets {
  geo: PieceGeometry
  bitmaps: HTMLCanvasElement[]
  image: HTMLImageElement
}

/** 조각이 붙었을 때 잠깐 보여줄 반짝임 */
export interface SnapEffect {
  ids: number[]
  at: number
  kind: 'board' | 'piece'
}

export type ConnectionStatus = 'connecting' | 'loading' | 'ready' | 'reconnecting' | 'closed'

/** React 화면(HUD)이 구독하는 값. 바뀔 때마다 새 객체가 만들어진다. */
export interface GameSnapshot {
  status: ConnectionStatus
  error: string | null
  players: PlayerInfo[]
  meId: string | null
  /** 남은 덩어리 수 (1이면 완성) */
  groups: number
  total: number
  solved: boolean
}

const SEND_INTERVAL_MS = 33 // 커서/조각 이동은 초당 약 30번만 전송
const MAX_RETRIES = 30

export class GameClient {
  puzzle: PuzzleConfig | null = null
  pieces: ClientPiece[] = []
  players = new Map<string, ClientPlayer>()
  meId: string | null = null
  assets: PuzzleAssets | null = null
  /** 내가 지금 들고 있는 덩어리의 조각 하나 (서버가 거부하면 null로 바뀜) */
  myHeld: number | null = null
  /** 최근에 붙은 조각들 (렌더러가 읽고 오래된 것은 지운다) */
  effects: SnapEffect[] = []

  private ws: WebSocket | null = null
  private listeners = new Set<() => void>()
  private snapshot: GameSnapshot = {
    status: 'connecting',
    error: null,
    players: [],
    meId: null,
    groups: 0,
    total: 0,
    solved: false,
  }
  private status: ConnectionStatus = 'connecting'
  private error: string | null = null
  private solved = false
  private destroyed = false
  private retry = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private assetsKey = ''
  private maxZ = 0
  private groupMap = new Map<number, ClientPiece[]>()

  private pendingCursor: { x: number; y: number } | null = null
  private pendingMove: { piece: number; x: number; y: number } | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private lastFlush = 0

  constructor(
    private readonly roomId: string,
    private readonly name: string,
  ) {
    this.connect()
  }

  // ---------- React 연동 (useSyncExternalStore) ----------
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot

  private publish() {
    this.snapshot = {
      status: this.status,
      error: this.error,
      players: [...this.players.values()].map((p) => p.info),
      meId: this.meId,
      groups: this.groupMap.size,
      total: this.pieces.length,
      solved: this.solved,
    }
    for (const l of this.listeners) l()
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status
    this.publish()
  }

  // ---------- 덩어리 헬퍼 ----------
  private rebuildGroups() {
    this.groupMap = new Map()
    for (const p of this.pieces) {
      const list = this.groupMap.get(p.group)
      if (list) list.push(p)
      else this.groupMap.set(p.group, [p])
    }
  }

  /** 이 조각과 이어 붙은 모든 조각 (자기 자신 포함) */
  membersOf(piece: ClientPiece): ClientPiece[] {
    return this.groupMap.get(piece.group) ?? [piece]
  }

  private home(id: number) {
    const p = this.puzzle!
    const pw = p.imageWidth / p.cols
    const ph = p.imageHeight / p.rows
    return { x: (id % p.cols) * pw, y: Math.floor(id / p.cols) * ph }
  }

  /** (anchor 조각이 x, y에 오도록) 덩어리 전체를 옮긴다. instant면 화면 위치도 바로 옮긴다. */
  private moveGroup(anchor: ClientPiece, x: number, y: number, instant: boolean) {
    const ha = this.home(anchor.id)
    for (const m of this.membersOf(anchor)) {
      const hm = this.home(m.id)
      m.tx = x + (hm.x - ha.x)
      m.ty = y + (hm.y - ha.y)
      if (instant) {
        m.x = m.tx
        m.y = m.ty
      }
    }
  }

  /** 덩어리가 테이블 밖으로 나가지 않도록 anchor 조각의 위치를 제한한다. (서버와 같은 규칙) */
  private clampGroupPos(anchor: ClientPiece, x: number, y: number) {
    const puzzle = this.puzzle!
    const { bounds } = puzzle
    const pw = puzzle.imageWidth / puzzle.cols
    const ph = puzzle.imageHeight / puzzle.rows
    const ha = this.home(anchor.id)
    let minHX = Infinity
    let maxHX = -Infinity
    let minHY = Infinity
    let maxHY = -Infinity
    for (const m of this.membersOf(anchor)) {
      const h = this.home(m.id)
      minHX = Math.min(minHX, h.x)
      maxHX = Math.max(maxHX, h.x)
      minHY = Math.min(minHY, h.y)
      maxHY = Math.max(maxHY, h.y)
    }
    const loX = bounds.minX - minHX
    const hiX = Math.max(loX, bounds.maxX - pw - maxHX)
    const loY = bounds.minY - minHY
    const hiY = Math.max(loY, bounds.maxY - ph - maxHY)
    return {
      x: ha.x + Math.min(Math.max(x - ha.x, loX), hiX),
      y: ha.y + Math.min(Math.max(y - ha.y, loY), hiY),
    }
  }

  private myGroupId(): number | null {
    return this.myHeld === null ? null : (this.pieces[this.myHeld]?.group ?? null)
  }

  // ---------- 연결 ----------
  private connect() {
    if (this.destroyed) return
    const ws = new WebSocket(wsUrl('/ws'))
    this.ws = ws

    ws.onopen = () => {
      this.send({ t: 'join', roomId: this.roomId, name: this.name })
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      try {
        this.handle(JSON.parse(ev.data) as ServerMessage)
      } catch (err) {
        console.error('메시지 처리 실패', err)
      }
    }
    ws.onclose = (ev) => {
      if (this.destroyed || this.ws !== ws) return
      this.ws = null
      this.myHeld = null
      const fatal = ev.code === 4003 || ev.code === 4004 || this.error !== null
      if (fatal || this.retry >= MAX_RETRIES) {
        if (!this.error) this.error = '서버와 연결이 끊어졌어요.'
        this.setStatus('closed')
        return
      }
      this.setStatus('reconnecting')
      const delay = Math.min(1000 * ++this.retry, 5000)
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
    }
  }

  destroy() {
    this.destroyed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.ws?.close()
    this.ws = null
    this.listeners.clear()
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  // ---------- 서버 메시지 처리 ----------
  private handle(msg: ServerMessage) {
    switch (msg.t) {
      case 'welcome': {
        this.retry = 0
        this.puzzle = msg.puzzle
        this.meId = msg.you
        this.solved = msg.solved
        this.myHeld = null
        this.effects = []
        this.pieces = msg.pieces.map((p) => ({ ...p, tx: p.x, ty: p.y }))
        this.rebuildGroups()
        this.maxZ = this.pieces.reduce((m, p) => Math.max(m, p.z), 0)
        this.players = new Map(msg.players.map((info) => [info.id, this.newPlayer(info)]))
        if (this.assets && this.assetsKey === this.assetKeyFor(msg.puzzle)) this.status = 'ready'
        else this.status = 'loading'
        this.publish()
        void this.loadAssets(msg.puzzle)
        break
      }
      case 'player_join':
        this.players.set(msg.player.id, this.newPlayer(msg.player))
        this.publish()
        break
      case 'player_leave':
        this.players.delete(msg.id)
        this.publish()
        break
      case 'cursor': {
        const p = this.players.get(msg.id)
        if (!p) break
        p.tx = msg.x
        p.ty = msg.y
        p.lastSeen = performance.now()
        if (!p.hasCursor) {
          p.x = msg.x
          p.y = msg.y
          p.hasCursor = true
        }
        break
      }
      case 'grab': {
        const piece = this.pieces[msg.piece]
        if (!piece) break
        for (const m of this.membersOf(piece)) {
          m.heldBy = msg.by
          m.z = msg.z
        }
        this.maxZ = Math.max(this.maxZ, msg.z)
        // 같은 덩어리를 다른 사람이 먼저 잡았다 → 내 드래그는 취소된다.
        if (msg.by !== this.meId && this.myGroupId() === piece.group) this.myHeld = null
        break
      }
      case 'grab_denied': {
        const piece = this.pieces[msg.piece]
        if (!piece) break
        const members = this.membersOf(piece)
        this.moveGroup(piece, msg.x, msg.y, false)
        for (const m of members) {
          m.locked = msg.locked
          if (m.heldBy === this.meId) m.heldBy = null
        }
        if (this.myGroupId() === piece.group) this.myHeld = null
        this.publish()
        break
      }
      case 'move': {
        const piece = this.pieces[msg.piece]
        if (piece && piece.heldBy !== this.meId) this.moveGroup(piece, msg.x, msg.y, false)
        break
      }
      case 'drop': {
        for (const u of msg.pieces) {
          const p = this.pieces[u.id]
          if (!p) continue
          p.tx = u.x
          p.ty = u.y
          p.group = u.group
          p.locked = u.locked
          p.z = u.z
          p.heldBy = null
          this.maxZ = Math.max(this.maxZ, u.z)
        }
        this.rebuildGroups()
        if (this.myHeld !== null && msg.pieces.some((u) => u.id === this.myHeld)) this.myHeld = null
        if (msg.snap) {
          this.effects.push({ ids: msg.pieces.map((u) => u.id), at: performance.now(), kind: msg.snap })
        }
        const by = this.players.get(msg.by)
        if (by && msg.gained > 0) by.info = { ...by.info, placed: by.info.placed + msg.gained }
        this.publish()
        break
      }
      case 'complete':
        this.solved = true
        this.publish()
        break
      case 'error':
        this.error = msg.message
        this.publish()
        break
    }
  }

  private newPlayer(info: PlayerInfo): ClientPlayer {
    return { info, x: 0, y: 0, tx: 0, ty: 0, hasCursor: false, lastSeen: 0 }
  }

  private assetKeyFor(p: PuzzleConfig) {
    return `${p.roomId}:${p.seed}`
  }

  private async loadAssets(puzzle: PuzzleConfig) {
    const key = this.assetKeyFor(puzzle)
    if (this.assetsKey === key) return
    this.assetsKey = key
    try {
      const image = new Image()
      image.src = apiUrl(puzzle.imageUrl)
      await image.decode()
      if (this.destroyed || this.assetsKey !== key) return
      const geo = buildGeometry(puzzle)
      const bitmaps = renderPieceBitmaps(image, puzzle, geo)
      this.assets = { geo, bitmaps, image }
      this.setStatus('ready')
    } catch (err) {
      console.error('이미지 로드 실패', err)
      this.assetsKey = ''
      this.error = '퍼즐 이미지를 불러오지 못했어요.'
      this.setStatus('closed')
    }
  }

  // ---------- 내 입력 → 서버 ----------
  sendCursor(x: number, y: number) {
    this.pendingCursor = { x, y }
    this.schedule()
  }

  /** 조각(이 붙어 있는 덩어리 전체) 잡기를 시도한다. 화면에서는 바로 들어 올리고, 서버가 거부하면 되돌린다. */
  beginGrab(id: number): boolean {
    const piece = this.pieces[id]
    if (!piece || piece.locked || this.meId === null) return false
    if (piece.heldBy !== null && piece.heldBy !== this.meId) return false
    const z = ++this.maxZ
    for (const m of this.membersOf(piece)) {
      m.heldBy = this.meId
      m.z = z
    }
    this.myHeld = id
    this.send({ t: 'grab', piece: id })
    return true
  }

  /** 잡고 있는 덩어리를 옮긴다. (id 조각이 x, y에 오도록) */
  dragTo(id: number, x: number, y: number) {
    const piece = this.pieces[id]
    if (!piece) return
    const pos = this.clampGroupPos(piece, x, y)
    this.moveGroup(piece, pos.x, pos.y, true)
    this.pendingMove = { piece: id, x: pos.x, y: pos.y }
    this.schedule()
  }

  endDrag(id: number) {
    const piece = this.pieces[id]
    if (!piece) return
    this.pendingMove = null
    this.flush()
    this.send({ t: 'drop', piece: id, x: piece.tx, y: piece.ty })
    this.myHeld = null
  }

  private schedule() {
    if (this.flushTimer !== null) return
    const wait = Math.max(0, SEND_INTERVAL_MS - (performance.now() - this.lastFlush))
    this.flushTimer = setTimeout(() => this.flush(), wait)
  }

  private flush() {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.lastFlush = performance.now()
    if (this.pendingMove) {
      this.send({ t: 'move', ...this.pendingMove })
      this.pendingMove = null
    }
    if (this.pendingCursor) {
      this.send({ t: 'cursor', ...this.pendingCursor })
      this.pendingCursor = null
    }
  }

  // ---------- 프레임마다 호출: 다른 사람의 조각/커서를 부드럽게 따라가게 한다 ----------
  step(dtSec: number) {
    const kPiece = 1 - Math.exp(-dtSec * 18)
    const kCursor = 1 - Math.exp(-dtSec * 28)
    const dragging = this.myHeld !== null
    for (const p of this.pieces) {
      // 내가 끌고 있는 덩어리는 마우스를 그대로 따라가야 한다.
      if (dragging && p.heldBy === this.meId) continue
      const dx = p.tx - p.x
      const dy = p.ty - p.y
      if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
        p.x = p.tx
        p.y = p.ty
      } else {
        p.x += dx * kPiece
        p.y += dy * kPiece
      }
    }
    for (const pl of this.players.values()) {
      pl.x += (pl.tx - pl.x) * kCursor
      pl.y += (pl.ty - pl.y) * kCursor
    }
  }
}
