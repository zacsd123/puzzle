import { randomBytes, randomInt } from 'node:crypto'
import type { WebSocket } from 'ws'
import {
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
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
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
  readonly puzzle: PuzzleConfig
  readonly image: Buffer
  readonly mime: string
  lastActive = Date.now()
  solved = false

  private readonly pw: number
  private readonly ph: number
  private pieces: PieceState[]
  private players = new Map<string, Player>()
  private zCounter = 0

  constructor(opts: {
    id: string
    cols: number
    rows: number
    imageWidth: number
    imageHeight: number
    image: Buffer
    mime: string
  }) {
    this.id = opts.id
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
      roomId: opts.id,
      cols: opts.cols,
      rows: opts.rows,
      imageWidth: opts.imageWidth,
      imageHeight: opts.imageHeight,
      seed: randomInt(1, 2 ** 31 - 1),
      bounds,
      imageUrl: `/api/rooms/${opts.id}/image`,
    }
    const { pw, ph } = cellSize(this.puzzle)
    this.pw = pw
    this.ph = ph
    this.pieces = this.scatter()
  }

  get playerCount() {
    return this.players.size
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

  private pickColor(): string {
    const used = new Set([...this.players.values()].map((p) => p.info.color))
    const free = PLAYER_COLORS.filter((c) => !used.has(c))
    const pool = free.length > 0 ? free : PLAYER_COLORS
    return pool[randomInt(pool.length)]
  }

  join(ws: WebSocket, rawName: unknown): Player | null {
    const name = sanitizeName(rawName)
    if (!name) {
      send(ws, { t: 'error', message: '이름을 입력해 주세요.' })
      return null
    }
    if (this.players.size >= MAX_PLAYERS) {
      send(ws, { t: 'error', message: '방이 가득 찼어요.' })
      return null
    }
    const player: Player = {
      info: {
        id: randomBytes(6).toString('hex'),
        name: this.uniqueName(name),
        color: this.pickColor(),
        placed: 0,
      },
      ws,
      holding: null,
    }
    this.players.set(player.info.id, player)
    this.lastActive = Date.now()

    send(ws, {
      t: 'welcome',
      you: player.info.id,
      puzzle: this.puzzle,
      pieces: this.pieces,
      players: [...this.players.values()].map((p) => p.info),
      solved: this.solved,
    })
    this.broadcast({ t: 'player_join', player: player.info }, player.info.id)
    return player
  }

  leave(player: Player) {
    if (!this.players.has(player.info.id)) return
    if (player.holding !== null) this.release(player, player.holding)
    this.players.delete(player.info.id)
    this.lastActive = Date.now()
    this.broadcast({ t: 'player_leave', id: player.info.id })
  }

  // ---------- 메시지 처리 ----------
  handle(player: Player, msg: unknown) {
    if (typeof msg !== 'object' || msg === null) return
    const m = msg as Record<string, unknown>
    this.lastActive = Date.now()

    switch (m.t) {
      case 'cursor':
        if (isNum(m.x) && isNum(m.y)) {
          this.broadcast({ t: 'cursor', id: player.info.id, x: m.x, y: m.y }, player.info.id)
        }
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
    let gained = 0

    // 1) 퍼즐판 정답 자리
    const off0 = this.offsetOf(members[0])
    if (!members[0].locked && Math.hypot(off0.x, off0.y) <= thr) {
      this.setOffset(members, 0, 0)
      for (const m of members) m.locked = true
      snap = 'board'
      gained++
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
          gained++
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

    return { touched, snap, gained }
  }
}

export class RoomManager {
  private rooms = new Map<string, Room>()

  get(id: string): Room | undefined {
    return this.rooms.get(id.toUpperCase())
  }

  create(opts: {
    cols: number
    rows: number
    imageWidth: number
    imageHeight: number
    image: Buffer
    mime: string
  }): Room | null {
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
