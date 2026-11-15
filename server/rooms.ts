import { randomBytes, randomInt } from 'node:crypto'
import type { WebSocket } from 'ws'
import {
  CLIENT_TOKEN_PATTERN,
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  cellSize,
  snapThreshold,
} from '../shared/protocol'
import type {
  Bounds,
  PieceState,
  PieceUpdate,
  PlayerInfo,
  PuzzleConfig,
  RoomSummary,
  ServerMessage,
} from '../shared/protocol'

const MAX_PLAYERS = 20
const MAX_ROOMS = 100
const EMPTY_ROOM_TTL_MS = 6 * 60 * 60 * 1000
/** 방마다 기억해 둘 "나간 사람" 기록 수. 이보다 많아지면 가장 오래된 것부터 잊는다. */
const MAX_RECORDS = 200

const PLAYER_COLORS = [
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#84cc16',
  '#06b6d4',
  '#a855f7',
  '#e11d48',
]

interface Player {
  info: PlayerInfo
  ws: WebSocket
  /** 지금 들고 있는 덩어리 번호 (없으면 null) */
  holding: number | null
  /** 나갈 때 기록을 남기는 데 쓰는 브라우저 식별값. 없으면(또는 다른 탭이 이미 쓰는 중이면) 기록을 남기지 않는다. */
  token: string | null
  /** 이 화면(탭)의 식별값. 같은 탭이 재접속한 것인지 알아보는 데 쓴다. */
  session: string
}

/** 나간 사람이 다시 들어왔을 때 되돌려 줄 기록 */
interface PlayerRecord {
  placed: number
  color: string
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export function sanitizeToken(raw: unknown): string | null {
  return typeof raw === 'string' && CLIENT_TOKEN_PATTERN.test(raw) ? raw : null
}

/** 퍼즐 하나를 이루는 값. 방을 만들 때와 새 퍼즐을 시작할 때 쓴다. */
export interface PuzzleSetup {
  cols: number
  rows: number
  imageWidth: number
  imageHeight: number
  image: Buffer
  mime: string
}

/** 입력 도중의 글이므로 끝의 공백은 남기고, 제어문자/줄바꿈만 정리해서 MAX_CHAT_LENGTH자로 자른다. */
function sanitizeChat(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const clean = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^ /, '')
  return Array.from(clean).slice(0, MAX_CHAT_LENGTH).join('')
}

function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

export class Room {
  readonly id: string
  // 퍼즐 한 판에 해당하는 값들. 방장이 새 퍼즐을 시작하면 setup()이 통째로 새로 채운다.
  puzzle!: PuzzleConfig
  image!: Buffer
  mime!: string
  lastActive = Date.now()
  solved = false

  private pw = 0
  private ph = 0
  private pieces: PieceState[] = []
  private players = new Map<string, Player>()
  /** 지금 접속 중인 사람들의 token → 플레이어 */
  private byToken = new Map<string, Player>()
  /** 나간 사람들의 token → 기록. 다시 들어오면 이어서 쓴다. */
  private records = new Map<string, PlayerRecord>()
  private zCounter = 0
  /** 몇 번째 판인지. 사진 주소에 붙여서 브라우저가 이전 판의 사진을 재사용하지 않게 한다. */
  private round = 0
  /** 방을 만든 브라우저의 식별값. 이 값으로 들어온 참가자가 방장이다. */
  private readonly ownerToken: string | null
  private hostId: string | null = null

  constructor(opts: PuzzleSetup & { id: string; ownerToken: string | null }) {
    this.id = opts.id
    this.ownerToken = opts.ownerToken
    this.setup(opts)
  }

  /** 새 퍼즐(사진, 격자, 조각 배치)로 방을 채운다. 참가자/기록은 건드리지 않는다. */
  private setup(opts: PuzzleSetup) {
    this.image = opts.image
    this.mime = opts.mime

    const margin = Math.round(Math.min(opts.imageWidth, opts.imageHeight) * 0.55)
    const bounds: Bounds = {
      minX: -margin,
      minY: -margin,
      maxX: opts.imageWidth + margin,
      maxY: opts.imageHeight + margin,
    }
    this.puzzle = {
      roomId: this.id,
      cols: opts.cols,
      rows: opts.rows,
      imageWidth: opts.imageWidth,
      imageHeight: opts.imageHeight,
      seed: randomInt(1, 2 ** 31 - 1),
      bounds,
      imageUrl: `/api/rooms/${this.id}/image?v=${this.round}`,
    }
    const { pw, ph } = cellSize(this.puzzle)
    this.pw = pw
    this.ph = ph
    this.zCounter = 0
    this.solved = false
    this.pieces = this.scatter()
  }

  get playerCount() {
    return this.players.size
  }

  // ---------- 방장 / 새 퍼즐 ----------
  /** 방장은 방을 만든 브라우저로 들어온 참가자. 그 사람이 없으면 가장 먼저 들어와 있는 참가자가 맡는다. */
  private computeHost(): string | null {
    if (this.ownerToken) {
      const owner = this.byToken.get(this.ownerToken)
      if (owner) return owner.info.id
    }
    const first = this.players.values().next().value
    return first ? first.info.id : null
  }

  /** 방장을 다시 계산한다. 바뀌었으면 true. */
  private refreshHost(): boolean {
    const next = this.computeHost()
    if (next === this.hostId) return false
    this.hostId = next
    return true
  }

  /** 지금 방장인 참가자의 식별값과 같은지. (새 퍼즐 시작 요청이 방장에게서 온 것인지 확인) */
  isHostToken(token: string): boolean {
    const host = this.hostId ? this.players.get(this.hostId) : undefined
    return !!host?.token && host.token === token
  }

  /**
   * 퍼즐을 완성한 뒤 방장이 새 사진으로 다시 시작한다. 완성 전이면 false.
   * 참가자는 그대로 두고 점수는 0으로 돌리며, 모두에게 새 퍼즐을 보낸다.
   */
  restart(opts: PuzzleSetup): boolean {
    if (!this.solved) return false
    this.round++
    this.setup(opts)
    this.records.clear() // 점수는 한 판 단위다. 나가 있던 사람의 이전 판 기록도 비운다.
    for (const p of this.players.values()) {
      p.holding = null
      p.info.placed = 0
    }
    this.lastActive = Date.now()
    for (const p of this.players.values()) this.sendWelcome(p)
    return true
  }

  private sendWelcome(player: Player) {
    send(player.ws, {
      t: 'welcome',
      you: player.info.id,
      puzzle: this.puzzle,
      pieces: this.pieces,
      players: [...this.players.values()].map((p) => p.info),
      solved: this.solved,
      host: this.hostId,
    })
  }

  summary(): RoomSummary {
    return {
      id: this.id,
      cols: this.puzzle.cols,
      rows: this.puzzle.rows,
      players: this.players.size,
      solved: this.solved,
    }
  }

  // ---------- 좌표/덩어리 헬퍼 ----------
  /** 조각이 퍼즐판에서 있어야 할 자리 */
  private home(id: number) {
    return { x: (id % this.puzzle.cols) * this.pw, y: Math.floor(id / this.puzzle.cols) * this.ph }
  }

  /** 정답 자리 기준으로 얼마나 떨어져 있는지. 덩어리 안의 모든 조각은 같은 값이다. */
  private offsetOf(p: PieceState) {
    const h = this.home(p.id)
    return { x: p.x - h.x, y: p.y - h.y }
  }

  private setOffset(members: PieceState[], ox: number, oy: number) {
    for (const m of members) {
      const h = this.home(m.id)
      m.x = h.x + ox
      m.y = h.y + oy
    }
  }

  private members(group: number): PieceState[] {
    return this.pieces.filter((p) => p.group === group)
  }

  private neighbors(id: number): number[] {
    const { cols, rows } = this.puzzle
    const r = Math.floor(id / cols)
    const c = id % cols
    const out: number[] = []
    if (r > 0) out.push(id - cols)
    if (r < rows - 1) out.push(id + cols)
    if (c > 0) out.push(id - 1)
    if (c < cols - 1) out.push(id + 1)
    return out
  }

  /** 덩어리가 테이블 밖으로 나가지 않도록 오프셋을 제한한다. */
  private clampOffset(members: PieceState[], ox: number, oy: number) {
    const { bounds } = this.puzzle
    let minHX = Infinity
    let maxHX = -Infinity
    let minHY = Infinity
    let maxHY = -Infinity
    for (const m of members) {
      const h = this.home(m.id)
      minHX = Math.min(minHX, h.x)
      maxHX = Math.max(maxHX, h.x)
      minHY = Math.min(minHY, h.y)
      maxHY = Math.max(maxHY, h.y)
    }
    const loX = bounds.minX - minHX
    const hiX = bounds.maxX - this.pw - maxHX
    const loY = bounds.minY - minHY
    const hiY = bounds.maxY - this.ph - maxHY
    return {
      x: Math.min(Math.max(ox, loX), Math.max(loX, hiX)),
      y: Math.min(Math.max(oy, loY), Math.max(loY, hiY)),
    }
  }

  /** 보드 밖 테이블 위에 조각을 무작위로 흩뿌린다. 처음에는 조각마다 덩어리 하나. */
  private scatter(): PieceState[] {
    const { cols, rows, imageWidth: W, imageHeight: H, bounds } = this.puzzle
    const pieces: PieceState[] = []
    for (let id = 0; id < cols * rows; id++) {
      let x = 0
      let y = 0
      for (let attempt = 0; attempt < 60; attempt++) {
        x = bounds.minX + Math.random() * (bounds.maxX - bounds.minX - this.pw)
        y = bounds.minY + Math.random() * (bounds.maxY - bounds.minY - this.ph)
        const overlapsBoard = x < W && x + this.pw > 0 && y < H && y + this.ph > 0
        if (!overlapsBoard) break
      }
      pieces.push({ id, x, y, z: ++this.zCounter, locked: false, heldBy: null, group: id })
    }
    return pieces
  }

  // ---------- 접속 관리 ----------
  private broadcast(msg: ServerMessage, exceptId?: string) {
    const text = JSON.stringify(msg)
    for (const p of this.players.values()) {
      if (p.info.id === exceptId) continue
      if (p.ws.readyState === p.ws.OPEN) p.ws.send(text)
    }
  }

  private uniqueName(base: string): string {
    const taken = new Set([...this.players.values()].map((p) => p.info.name.toLowerCase()))
    if (!taken.has(base.toLowerCase())) return base
    for (let n = 2; n < 100; n++) {
      const suffix = ` (${n})`
      const candidate = base.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix
      if (!taken.has(candidate.toLowerCase())) return candidate
    }
    return base
  }

  /** preferred가 아직 아무도 안 쓰는 색이면 그 색을, 아니면 안 쓰는 색 중 하나를 고른다. */
  private pickColor(preferred?: string): string {
    const used = new Set([...this.players.values()].map((p) => p.info.color))
    if (preferred && !used.has(preferred)) return preferred
    const free = PLAYER_COLORS.filter((c) => !used.has(c))
    const pool = free.length > 0 ? free : PLAYER_COLORS
    return pool[randomInt(pool.length)]
  }

  private saveRecord(token: string, player: Player) {
    this.records.delete(token) // 다시 넣어서 "가장 최근" 순서로 만든다.
    this.records.set(token, { placed: player.info.placed, color: player.info.color })
    if (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value
      if (oldest !== undefined) this.records.delete(oldest)
    }
  }

  join(ws: WebSocket, rawName: unknown, rawToken?: unknown, rawSession?: unknown): Player | null {
    const name = sanitizeName(rawName)
    if (!name) {
      send(ws, { t: 'error', message: '이름을 입력해 주세요.' })
      return null
    }

    let token = sanitizeToken(rawToken)
    const session = typeof rawSession === 'string' ? rawSession.slice(0, 64) : ''
    const active = token ? this.byToken.get(token) : undefined
    if (token && active) {
      if (session && active.session === session) {
        // 같은 화면이 다시 접속했다. (새로고침, 네트워크가 잠깐 끊겼다 돌아온 경우 등)
        // 서버가 아직 끊긴 줄 모르는 이전 연결을 먼저 정리하고, 그 기록을 이어받는다.
        this.leave(active)
        send(active.ws, { t: 'error', message: '다른 화면에서 같은 방에 접속해서 이 화면의 연결이 종료됐어요.' })
        active.ws.close(4005, 'replaced')
        setTimeout(() => active.ws.terminate(), 2000).unref() // 응답 없는 연결이 남지 않도록
      } else {
        // 같은 브라우저의 다른 탭이다. 기록은 먼저 들어온 쪽이 쓰고, 이쪽은 따로 참가한다.
        token = null
      }
    }

    if (this.players.size >= MAX_PLAYERS) {
      send(ws, { t: 'error', message: '방이 가득 찼어요.' })
      return null
    }
    const record = token ? this.records.get(token) : undefined
    const player: Player = {
      info: {
        id: randomBytes(6).toString('hex'),
        name: this.uniqueName(name),
        color: this.pickColor(record?.color),
        placed: record?.placed ?? 0,
      },
      ws,
      holding: null,
      token,
      session,
    }
    this.players.set(player.info.id, player)
    if (token) this.byToken.set(token, player)
    this.lastActive = Date.now()

    const hostChanged = this.refreshHost() // welcome에 최신 방장이 담기도록 먼저 계산
    this.sendWelcome(player)
    this.broadcast({ t: 'player_join', player: player.info }, player.info.id)
    if (hostChanged) this.broadcast({ t: 'host', id: this.hostId }, player.info.id)
    return player
  }

  leave(player: Player) {
    if (!this.players.has(player.info.id)) return
    if (player.holding !== null) this.release(player, player.holding)
    this.players.delete(player.info.id)
    if (player.token && this.byToken.get(player.token) === player) {
      this.byToken.delete(player.token)
      this.saveRecord(player.token, player) // release()로 얻은 점수까지 포함해서 남긴다.
    }
    this.lastActive = Date.now()
    this.broadcast({ t: 'player_leave', id: player.info.id })
    if (this.refreshHost()) this.broadcast({ t: 'host', id: this.hostId })
  }

  // ---------- 메시지 처리 ----------
  handle(player: Player, msg: unknown) {
    if (typeof msg !== 'object' || msg === null) return
    // 이미 정리된(나갔거나 새 접속에 자리를 내준) 연결이 늦게 보낸 메시지는 무시한다.
    if (this.players.get(player.info.id) !== player) return
    const m = msg as Record<string, unknown>
    this.lastActive = Date.now()

    switch (m.t) {
      case 'cursor':
        if (isNum(m.x) && isNum(m.y)) {
          this.broadcast({ t: 'cursor', id: player.info.id, x: m.x, y: m.y }, player.info.id)
        }
        break
      case 'chat':
        this.broadcast({ t: 'chat', id: player.info.id, text: sanitizeChat(m.text) }, player.info.id)
        break
      case 'grab':
        if (isNum(m.piece)) this.grab(player, m.piece)
        break
      case 'move':
        if (isNum(m.piece) && isNum(m.x) && isNum(m.y)) this.move(player, m.piece, m.x, m.y)
        break
      case 'drop':
        if (isNum(m.piece) && isNum(m.x) && isNum(m.y)) this.drop(player, m.piece, m.x, m.y)
        break
    }
  }

  private pieceAt(id: number): PieceState | null {
    return Number.isInteger(id) ? (this.pieces[id] ?? null) : null
  }

  private grab(player: Player, id: number) {
    const piece = this.pieceAt(id)
    if (!piece) return
    if (piece.locked || (piece.heldBy !== null && piece.heldBy !== player.info.id)) {
      send(player.ws, { t: 'grab_denied', piece: id, x: piece.x, y: piece.y, locked: piece.locked })
      return
    }
    // 한 번에 한 덩어리만 든다.
    if (player.holding !== null && player.holding !== piece.group) this.release(player, player.holding)
    const z = ++this.zCounter
    for (const m of this.members(piece.group)) {
      m.heldBy = player.info.id
      m.z = z
    }
    player.holding = piece.group
    this.broadcast({ t: 'grab', piece: id, by: player.info.id, z })
  }

  /** (id 조각이 x, y에 오도록) 덩어리 전체를 옮긴다. */
  private placeGroup(piece: PieceState, x: number, y: number) {
    const members = this.members(piece.group)
    const h = this.home(piece.id)
    const off = this.clampOffset(members, x - h.x, y - h.y)
    this.setOffset(members, off.x, off.y)
  }

  private move(player: Player, id: number, x: number, y: number) {
    const piece = this.pieceAt(id)
    if (!piece || piece.heldBy !== player.info.id) return
    this.placeGroup(piece, x, y)
    this.broadcast({ t: 'move', piece: id, x: piece.x, y: piece.y }, player.info.id)
  }

  private drop(player: Player, id: number, x: number, y: number) {
    const piece = this.pieceAt(id)
    if (!piece || piece.heldBy !== player.info.id) return
    this.placeGroup(piece, x, y)
    this.release(player, piece.group)
  }

  /** 덩어리를 내려놓고, 붙을 수 있으면 붙인 뒤 결과를 모두에게 알린다. */
  private release(player: Player, groupId: number) {
    for (const m of this.members(groupId)) m.heldBy = null
    player.holding = null

    const { touched, snap, gained } = this.settle(groupId)
    player.info.placed += gained

    const updates: PieceUpdate[] = [...touched].map((id) => {
      const p = this.pieces[id]
      return { id, x: p.x, y: p.y, group: p.group, locked: p.locked, z: p.z }
    })
    this.broadcast({ t: 'drop', by: player.info.id, snap, gained, pieces: updates })

    if (!this.solved && this.pieces.every((p) => p.group === this.pieces[0].group)) {
      this.solved = true
      this.broadcast({ t: 'complete' })
    }
  }

  /**
   * 내려놓은 덩어리가 (1) 퍼즐판 정답 자리 근처인지, (2) 이웃 조각의 덩어리와 맞닿는 위치인지 확인해서
   * 붙일 수 있으면 붙인다. 붙이고 나면 새로 이웃이 된 덩어리와도 계속 검사한다.
   */
  private settle(startGroup: number) {
    const thr = snapThreshold(this.pw, this.ph)
    let groupId = startGroup
    let members = this.members(groupId)
    const touched = new Set(members.map((m) => m.id))
    let snap: 'board' | 'piece' | null = null

    // 1) 퍼즐판 정답 자리
    const off0 = this.offsetOf(members[0])
    if (!members[0].locked && Math.hypot(off0.x, off0.y) <= thr) {
      this.setOffset(members, 0, 0)
      for (const m of members) m.locked = true
      snap = 'board'
    }

    // 2) 이웃 덩어리와 합치기 (합칠 때마다 다시 처음부터 검사)
    let merged = true
    while (merged) {
      merged = false
      members = this.members(groupId)
      const mine = this.offsetOf(members[0])
      const locked = members[0].locked

      outer: for (const m of members) {
        for (const nId of this.neighbors(m.id)) {
          const other = this.pieces[nId]
          if (other.group === groupId) continue
          if (other.heldBy !== null) continue // 다른 사람이 들고 있는 덩어리는 건드리지 않는다.
          const og = this.offsetOf(other)
          if (Math.hypot(mine.x - og.x, mine.y - og.y) > thr) continue

          const otherMembers = this.members(other.group)
          if (locked && !other.locked) this.setOffset(otherMembers, 0, 0)
          else if (!locked && other.locked) this.setOffset(members, 0, 0)
          else if (!locked && !other.locked) this.setOffset(members, og.x, og.y)

          const newGroup = Math.min(groupId, other.group)
          const lockAll = locked || other.locked
          const z = ++this.zCounter
          for (const p of [...members, ...otherMembers]) {
            p.group = newGroup
            p.locked = lockAll
            p.z = z
            touched.add(p.id)
          }
          groupId = newGroup
          snap ??= 'piece'
          merged = true
          break outer
        }
      }
    }

    // 3) 모든 조각이 하나로 이어졌으면 어디에 있든 퍼즐판 위로 올려 완성시킨다.
    members = this.members(groupId)
    if (members.length === this.pieces.length && !members[0].locked) {
      this.setOffset(members, 0, 0)
      for (const m of members) m.locked = true
      snap = 'board'
    }

    // 점수는 "붙인 횟수"다. 한 번 내려놓아서 판에 맞춰지면서 이웃과도 붙었거나, 한꺼번에 여러 덩어리가
    // 붙었더라도 찰칵 한 번이므로 1점만 준다. (예전에는 판 고정과 이웃 연결을 따로 세서 2점씩 올랐다.)
    return { touched, snap, gained: snap ? 1 : 0 }
  }
}

export class RoomManager {
  private rooms = new Map<string, Room>()

  get(id: string): Room | undefined {
    return this.rooms.get(id.toUpperCase())
  }

  create(opts: PuzzleSetup & { ownerToken: string | null }): Room | null {
    if (this.rooms.size >= MAX_ROOMS) {
      this.sweep(0) // 비어있는 방부터 정리해 본다.
      if (this.rooms.size >= MAX_ROOMS) return null
    }
    let id = ''
    do {
      id = Array.from({ length: ROOM_CODE_LENGTH }, () =>
        ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)],
      ).join('')
    } while (this.rooms.has(id))
    const room = new Room({ id, ...opts })
    this.rooms.set(id, room)
    return room
  }

  /** 아무도 없는 채로 ttl 이상 지난 방을 지운다. */
  sweep(ttl = EMPTY_ROOM_TTL_MS) {
    const now = Date.now()
    for (const [id, room] of this.rooms) {
      if (room.playerCount === 0 && now - room.lastActive >= ttl) this.rooms.delete(id)
    }
  }
}
