import type {
  ClientMessage,
  PieceState,
  PlayerInfo,
  PuzzleConfig,
  ServerMessage,
} from '../../shared/protocol'
import { apiUrl, wsUrl } from '../lib/config'
import { loadClientId, loadTabId } from '../lib/storage'
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
  /** 커서 옆에 떠 있는 채팅 글. at은 마지막으로 글이 바뀐 시각(performance.now) */
  chat: { text: string; at: number } | null
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
  /** 방장 플레이어 id. 퍼즐을 완성하면 방장이 새 사진으로 다시 시작할 수 있다. */
  hostId: string | null
  /** 남은 덩어리 수 (1이면 완성) */
  groups: number
  total: number
  solved: boolean
}

const SEND_INTERVAL_MS = 33 // 커서/조각 이동은 초당 약 30번만 전송
const MAX_RETRIES = 30
/** 화면으로 돌아왔을 때 보낸 ping에 이 시간 안에 pong이 안 오면 연결이 죽은 것으로 보고 다시 연결한다. */
const PONG_TIMEOUT_MS = 3000

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
  /**
   * 화면에 보이는 상태(조각, 참가자, 커서, 연결 상태 등)가 바뀔 때마다 늘어나는 번호.
   * 렌더러는 이 번호가 그대로면 다시 그리지 않는다.
   */
  revision = 0

  private ws: WebSocket | null = null
  private listeners = new Set<() => void>()
  private snapshot: GameSnapshot = {
    status: 'connecting',
    error: null,
    players: [],
    meId: null,
    hostId: null,
    groups: 0,
    total: 0,
    solved: false,
  }
  private hostId: string | null = null
  private status: ConnectionStatus = 'connecting'
  private error: string | null = null
  private solved = false
  private destroyed = false
  private retry = 0
  /** 재시도를 다 써서 닫힌 상태인지 (서버가 입장을 거절해서 닫힌 것과 구분한다) */
  private exhausted = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private assetsKey = ''
  /** 이 브라우저의 식별값(저장됨)과 이 탭의 식별값(탭마다 다르고 새로고침해도 유지) */
  private readonly token = loadClientId()
  private readonly session = loadTabId()
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
    document.addEventListener('visibilitychange', this.onForeground)
    window.addEventListener('online', this.onForeground)
    window.addEventListener('pageshow', this.onForeground)
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
    this.revision++
    this.snapshot = {
      status: this.status,
      error: this.error,
      players: [...this.players.values()].map((p) => p.info),
      meId: this.meId,
      hostId: this.hostId,
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
      this.send({ t: 'join', roomId: this.roomId, name: this.name, token: this.token, session: this.session })
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      try {
        this.handle(JSON.parse(ev.data) as ServerMessage)
      } catch (err) {
        console.error('메시지 처리 실패', err)
      }
    }
    ws.onclose = (ev) => this.onSocketClosed(ws, ev.code)
  }

  private onSocketClosed(ws: WebSocket, code: number) {
    if (this.destroyed || this.ws !== ws) return
    this.ws = null
    this.myHeld = null
    this.clearPongTimer()
    // 4003 입장 거절, 4004 방 없음, 4005 같은 탭이 다른 연결로 대체됨 → 다시 연결을 시도하지 않는다.
    const fatal = code === 4003 || code === 4004 || code === 4005 || this.error !== null
    if (fatal) {
      if (!this.error) this.error = '서버와 연결이 끊어졌어요.'
      this.setStatus('closed')
      return
    }
    if (this.retry >= MAX_RETRIES) {
      // 재시도를 다 썼다. 화면으로 돌아오거나 네트워크가 다시 잡히면 한 번 더 시도한다. (onForeground)
      this.exhausted = true
      this.error = '서버와 연결이 끊어졌어요.'
      this.setStatus('closed')
      return
    }
    this.setStatus('reconnecting')
    const delay = Math.min(1000 * ++this.retry, 5000)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  /**
   * 휴대폰이 백그라운드에서 돌아오거나 네트워크가 다시 잡혔을 때, 다음 재시도를 기다리지 않고 바로 연결을 확인/복구한다.
   * (iOS는 화면이 꺼져 있던 연결이 끊긴 줄 모르고 "열림"으로 남겨 두기도 한다.)
   */
  private onForeground = () => {
    if (this.destroyed || document.visibilityState === 'hidden') return
    const ws = this.ws
    if (ws === null) {
      if (this.status === 'reconnecting' || this.exhausted) {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
        this.exhausted = false
        this.error = null
        this.retry = 0
        this.setStatus('reconnecting')
        this.connect()
      }
      return
    }
    if (ws.readyState !== WebSocket.OPEN) return
    // 열려 있는 것처럼 보여도 실제로는 끊겼을 수 있다. 확인해서 응답이 없으면 끊고 다시 연결한다.
    this.clearPongTimer()
    this.send({ t: 'ping' })
    this.pongTimer = setTimeout(() => {
      if (this.ws !== ws) return
      ws.onclose = null
      try {
        ws.close()
      } catch {
        /* 이미 닫힘 */
      }
      this.onSocketClosed(ws, 1006)
    }, PONG_TIMEOUT_MS)
  }

  private clearPongTimer() {
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pongTimer = null
  }

  destroy() {
    this.destroyed = true
    document.removeEventListener('visibilitychange', this.onForeground)
    window.removeEventListener('online', this.onForeground)
    window.removeEventListener('pageshow', this.onForeground)
    this.clearPongTimer()
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
    this.revision++ // 서버가 보낸 모든 소식은 화면에 영향을 줄 수 있다. (조각, 커서, 채팅, 참가자 …)
    switch (msg.t) {
      case 'welcome': {
        // 입장할 때뿐 아니라, 방장이 새 퍼즐을 시작했을 때도 모두에게 온다. (그때는 사진/격자가 통째로 바뀐다)
        this.retry = 0
        this.puzzle = msg.puzzle
        this.meId = msg.you
        this.hostId = msg.host
        this.solved = msg.solved
        this.myHeld = null
        this.effects = []
        this.pieces = msg.pieces.map((p) => ({ ...p, tx: p.x, ty: p.y }))
        this.rebuildGroups()
        this.maxZ = this.pieces.reduce((m, p) => Math.max(m, p.z), 0)
        // 이미 보고 있던 사람의 커서 위치/채팅은 새 퍼즐이 시작돼도 그대로 둔다.
        const prev = this.players
        this.players = new Map(
          msg.players.map((info) => {
            const old = prev.get(info.id)
            return [info.id, old ? { ...old, info } : this.newPlayer(info)]
          }),
        )
        const sameAssets = this.assetsKey === this.assetKeyFor(msg.puzzle)
        // 다른 퍼즐의 이미지/조각 그림으로 새 조각을 그리지 않도록 버린다.
        if (!sameAssets) this.assets = null
        this.status = this.assets && sameAssets ? 'ready' : 'loading'
        this.publish()
        void this.loadAssets(msg.puzzle)
        break
      }
      case 'host':
        this.hostId = msg.id
        this.publish()
        break
      case 'pong':
        this.clearPongTimer()
        break
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
      case 'chat': {
        const p = this.players.get(msg.id)
        if (!p) break
        const now = performance.now()
        p.chat = msg.text ? { text: msg.text, at: now } : null
        if (msg.text) p.lastSeen = now // 글을 쓰는 중이면 커서가 흐려지지 않게
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
    return { info, x: 0, y: 0, tx: 0, ty: 0, hasCursor: false, lastSeen: 0, chat: null }
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

  /** 커서 옆에 띄울 글을 보낸다. 입력 중인 글 전체를 보내고, 빈 문자열이면 다른 사람 화면에서 지워진다. */
  sendChat(text: string) {
    this.send({ t: 'chat', text })
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
    this.revision++
    this.send({ t: 'grab', piece: id })
    return true
  }

  /** 잡고 있는 덩어리를 옮긴다. (id 조각이 x, y에 오도록) */
  dragTo(id: number, x: number, y: number) {
    const piece = this.pieces[id]
    if (!piece) return
    const pos = this.clampGroupPos(piece, x, y)
    this.moveGroup(piece, pos.x, pos.y, true)
    this.revision++
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
    this.revision++
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
  /** 이번에 움직인(또는 제자리에 막 도착한) 조각/커서가 있으면 true. 렌더러는 아무것도 안 움직였으면 다시 그리지 않아도 된다. */
  step(dtSec: number): boolean {
    const kPiece = 1 - Math.exp(-dtSec * 18)
    const kCursor = 1 - Math.exp(-dtSec * 28)
    const dragging = this.myHeld !== null
    let moved = false
    for (const p of this.pieces) {
      // 내가 끌고 있는 덩어리는 마우스를 그대로 따라가야 한다.
      if (dragging && p.heldBy === this.meId) continue
      const dx = p.tx - p.x
      const dy = p.ty - p.y
      if (dx === 0 && dy === 0) continue
      if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
        p.x = p.tx
        p.y = p.ty
      } else {
        p.x += dx * kPiece
        p.y += dy * kPiece
      }
      moved = true
    }
    for (const pl of this.players.values()) {
      const dx = pl.tx - pl.x
      const dy = pl.ty - pl.y
      if (dx === 0 && dy === 0) continue
      // 거의 다 따라왔으면 딱 맞춘다. (끝없이 조금씩 다가가며 계속 다시 그리게 되지 않도록)
      if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
        pl.x = pl.tx
        pl.y = pl.ty
      } else {
        pl.x += dx * kCursor
        pl.y += dy * kCursor
      }
      moved = true
    }
    return moved
  }
}
