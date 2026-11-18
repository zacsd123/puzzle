import { chatOpacity } from './chat'
import type { ClientPiece, GameClient } from './GameClient'
import { SIDES } from './jigsaw'

/** 조각이 붙을 때 반짝이는 시간(ms) */
const FLASH_MS = 550

// ---- 조각이 많을 때의 렌더링 비용 조절 ----
// (측정: 조각을 줄여서 그릴 때 고화질 보간은 조각이 많을수록 급격히 느려진다.
//  300조각을 실제 배율 0.5~0.7로 보면 고화질 33~39ms/프레임, 낮은 화질 7ms. 1000조각은 0.9 근처까지 차이가 난다.)
/** 이 수보다 조각이 많고 줄여서 보는 중이면 가벼운 보간으로 그린다. */
const HEAVY_PIECE_COUNT = 100
/** 실제 화면 배율(줌 × 화면 배율)이 이보다 작으면(= 조각 그림을 줄여서 그리면) 브라우저가 느린 축소 보간 경로를 탄다. */
const DOWNSCALE_SLOW_BELOW = 1.0
/** 들고 있는 덩어리의 그림자는 조각마다 흐림 효과를 따로 계산해서, 큰 덩어리는 그림자를 생략한다. */
const SHADOW_MAX_PIECES = 60
/**
 * 캔버스를 실제 화면 픽셀(devicePixelRatio)만큼 촘촘하게 만들되 상한을 둔다. 휴대폰처럼 배율이 3인 화면은 픽셀 수가 많아서,
 * 조각이 많을 때는 2로 낮춘다. (측정: 같은 장면이 300조각에서 배율 3은 2보다 약 2배, 1000조각 확대 화면은 2배 이상 느림)
 */
const MAX_DPR = 3
const MAX_DPR_HEAVY = 2
/**
 * 판에 맞춰진(고정된) 조각은 다시 움직이지 않으므로 한 장의 그림(레이어)에 미리 모아 두고, 많이 줄여서 볼 때는 그 한 장만 그린다.
 * 조각 1000개를 개별로 그리면 프레임당 10~17ms, 한 장으로 그리면 2~3ms. 확대해서 볼 때는 화면에 보이는 조각만 직접 그려서 선명함을 지킨다.
 * 실제 화면 배율(줌 × 화면 배율)이 이 값보다 작을 때만 레이어를 쓴다.
 */
const LAYER_BELOW_SCALE = 1.5
/**
 * 화면에 아무 변화가 없으면 다시 그리지 않는다. (조각 1000개 전체 보기는 한 프레임에 약 17ms라서, 정지 화면에서도 GPU가 쉬지 못했다.)
 * 변화를 놓치더라도 화면이 오래 굳어 있지 않도록, 변화가 없어도 이 시간마다 한 번은 그린다.
 */
const IDLE_REDRAW_MS = 1000
/** "C"로 찾은 조각이 반짝이는 시간(ms) */
const LOCATE_MS = 2400

/** 다른 사람 커서가 이 시간 동안 안 움직이면 흐리게 그린다. */
const CURSOR_IDLE_MS = 6000

// ---- 터치 조작 ----
/** 손가락(펜)으로 조각을 누를 때 조금 빗나가도 가까운 조각을 집어 주는 여유. (화면 px) 마우스는 정확히 눌러야 한다. */
const TOUCH_SLOP_PX = 16
const PEN_SLOP_PX = 8
/** 손가락으로 조각을 집으면 손가락에 가려지지 않게 이만큼 위로 띄운다. (화면 px) */
const TOUCH_LIFT_PX = 28
/** 손가락(펜)으로 조각을 끌다가 화면 가장자리 이 거리 안에 들어가면 화면이 그쪽으로 따라 움직인다. (화면 px) */
const EDGE_PAN_ZONE_PX = 56
/** 가장자리 끝에서의 화면 이동 속도 (화면 px/초). 가장자리에서 멀어질수록 느려진다. */
const EDGE_PAN_SPEED = 650

/** roundRect가 없는 브라우저(iOS 15 이하 등)에서도 쓸 수 있게 직접 만든 둥근 사각형 경로 */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number) {
  const r = Math.min(radius, w / 2, h / 2)
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** 고정된 조각을 월드 좌표 그대로(배율 1) 모아 둔 그림. 왼쪽 위가 월드 (-pad, -pad). */
interface LockedLayer {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  /** 조각 번호별로 이미 그려 넣었는지 */
  baked: Uint8Array
  count: number
}

interface Camera {
  scale: number
  ox: number
  oy: number
}

type Drag =
  | { kind: 'piece'; id: number; dx: number; dy: number }
  | { kind: 'pan'; lastX: number; lastY: number }

const MAX_SCALE = 3

/**
 * 캔버스 렌더링 + 마우스 입력.
 * 카메라(줌/이동)는 각자 로컬이고, 서버로 보내는 좌표는 모두 월드 좌표라서
 * 화면 크기/줌이 달라도 모든 사람에게 같은 위치로 보인다.
 */
export class BoardView {
  private ctx: CanvasRenderingContext2D
  private hitCtx: CanvasRenderingContext2D
  private cam: Camera = { scale: 1, ox: 0, oy: 0 }
  private width = 0
  private height = 0
  private dpr = 1
  private fitted = false
  private minScale = 0.1
  private showGhost = false
  /** 사용자가 직접 줌/이동했는지. 아니라면 창 크기가 바뀔 때 자동으로 전체 보기에 맞춘다. */
  private userMoved = false
  private drag: Drag | null = null
  /** 마지막으로 그린 퍼즐의 이미지/조각 그림. 바뀌면 새 퍼즐이 시작된 것이다. */
  private lastAssets: object | null = null
  private lockedLayer: LockedLayer | null = null
  private raf = 0
  private lastTime = 0
  private ro: ResizeObserver
  // ---- 다시 그릴지 판단하는 값들 ----
  /** 카메라/크기/힌트 같은, 렌더러 안에서 바뀐 것이 있어서 다시 그려야 하는지 */
  private dirty = true
  /** 마지막으로 그렸을 때의 client.revision */
  private seenRevision = -1
  private lastDrawAt = 0
  /** 다른 사람 커서를 마지막으로 흐리게/또렷하게 그렸던 상태 (시간이 지나 상태가 바뀌면 다시 그린다) */
  private cursorIdleDrawn = new Map<string, boolean>()
  /** 마지막으로 그린 자유 조각들 (z 오름차순). 히트 테스트에서 위에 있는 조각부터 검사하는 데 쓴다. */
  private drawOrder: number[] = []
  // ---- 여러 손가락 ----
  /** 지금 화면에 닿아 있는 손가락/펜/마우스의 화면 좌표 */
  private pointers = new Map<number, { x: number; y: number }>()
  /** 두 손가락으로 확대·이동 중이면, 시작할 때의 두 손가락 간격/배율과 중심 아래에 있던 월드 좌표 */
  private pinch: { startDist: number; startScale: number; wx: number; wy: number } | null = null
  /** 조각을 들고 있는 동안 닿은 다른 손가락들. 확대/이동으로 쓰지 않고 무시한다. */
  private ignored = new Set<number>()
  /** 조각을 끄는 포인터의 종류와 마지막 화면 좌표 (가장자리 자동 이동에 쓴다) */
  private dragPointer: { x: number; y: number; type: string } | null = null
  /** 내 커서 위치를 서버에 한 번이라도 보냈는지 (터치 기기는 끌기 전까지 커서가 없다) */
  private cursorSent = false
  /** 마우스가 마지막으로 있던 화면 좌표. 캔버스 밖으로 나가면 null */
  private hover: { x: number; y: number } | null = null
  /** "C"로 찾은 조각 (나한테만 보인다) */
  private locating: { id: number; at: number } | null = null

  constructor(
    private canvas: HTMLCanvasElement,
    private client: GameClient,
  ) {
    this.ctx = canvas.getContext('2d')!
    this.hitCtx = document.createElement('canvas').getContext('2d')!

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.preventDefault)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('mousedown', this.onMouseDown)

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.resize()
    this.raf = requestAnimationFrame(this.frame)
  }

  /** 다음 프레임에 반드시 다시 그리게 한다. */
  invalidate = () => {
    this.dirty = true
  }

  private onVisibility = () => {
    // 화면이 가려지면 닿아 있던 손가락 정보는 믿을 수 없다. 들고 있던 조각은 그 자리에 내려놓는다.
    if (document.hidden) this.cancelGestures()
    this.dirty = true
  }

  private cancelGestures() {
    const drag = this.drag
    this.drag = null
    this.pinch = null
    this.pointers.clear()
    this.ignored.clear()
    this.dragPointer = null
    if (drag?.kind === 'piece' && this.client.myHeld === drag.id) this.client.endDrag(drag.id)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    document.removeEventListener('visibilitychange', this.onVisibility)
    const c = this.canvas
    c.removeEventListener('pointerdown', this.onPointerDown)
    c.removeEventListener('pointermove', this.onPointerMove)
    c.removeEventListener('pointerup', this.onPointerUp)
    c.removeEventListener('pointercancel', this.onPointerUp)
    c.removeEventListener('wheel', this.onWheel)
    c.removeEventListener('contextmenu', this.preventDefault)
    c.removeEventListener('pointerleave', this.onPointerLeave)
    c.removeEventListener('mousedown', this.onMouseDown)
  }

  // ---------- 공개 API (HUD 버튼용) ----------
  setGhost(on: boolean) {
    this.showGhost = on
    this.dirty = true
  }

  /** 테이블 전체가 한눈에 보이도록 맞춘다. */
  fit() {
    const puzzle = this.client.puzzle
    if (!puzzle || this.width === 0) return
    const { bounds } = puzzle
    const bw = bounds.maxX - bounds.minX
    const bh = bounds.maxY - bounds.minY
    const margin = 24
    const scale = Math.min((this.width - margin * 2) / bw, (this.height - margin * 2) / bh)
    this.minScale = scale * 0.5
    this.cam.scale = scale
    this.cam.ox = (this.width - bw * scale) / 2 - bounds.minX * scale
    this.cam.oy = (this.height - bh * scale) / 2 - bounds.minY * scale
    this.fitted = true
    this.userMoved = false
    this.dirty = true
  }

  zoomBy(factor: number) {
    this.userMoved = true
    this.zoomAt(this.width / 2, this.height / 2, this.cam.scale * factor)
  }

  // ---------- 크기/좌표 ----------
  private resize() {
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    const maxDpr = this.client.pieces.length > HEAVY_PIECE_COUNT ? MAX_DPR_HEAVY : MAX_DPR
    this.dpr = Math.min(window.devicePixelRatio || 1, maxDpr)
    const hadSize = this.width > 0
    const prevW = this.width
    const prevH = this.height
    this.width = w
    this.height = h
    this.canvas.width = Math.max(1, Math.round(w * this.dpr))
    this.canvas.height = Math.max(1, Math.round(h * this.dpr))
    this.dirty = true // 캔버스 크기를 바꾸면 그림이 지워진다.
    if (!this.fitted || !hadSize) return
    if (this.userMoved) {
      // 직접 보던 화면은 중심을 유지한다.
      this.cam.ox += (w - prevW) / 2
      this.cam.oy += (h - prevH) / 2
    } else {
      this.fit()
    }
  }

  private toScreen(e: { clientX: number; clientY: number }) {
    const rect = this.canvas.getBoundingClientRect()
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top }
  }

  private toWorld(sx: number, sy: number) {
    return { x: (sx - this.cam.ox) / this.cam.scale, y: (sy - this.cam.oy) / this.cam.scale }
  }

  private zoomAt(sx: number, sy: number, next: number) {
    const scale = Math.min(MAX_SCALE, Math.max(this.minScale, next))
    const wx = (sx - this.cam.ox) / this.cam.scale
    const wy = (sy - this.cam.oy) / this.cam.scale
    this.cam.scale = scale
    this.cam.ox = sx - wx * scale
    this.cam.oy = sy - wy * scale
    this.dirty = true
  }

  // ---------- 입력 ----------
  private preventDefault = (e: Event) => e.preventDefault()

  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault() // 가운데 버튼 자동 스크롤 방지
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    this.userMoved = true
    const { sx, sy } = this.toScreen(e)
    this.zoomAt(sx, sy, this.cam.scale * Math.exp(-e.deltaY * 0.0012))
  }

  /** 포인터 종류별로 조각을 누를 때 봐 주는 여유(화면 px) */
  private slopFor(pointerType: string): number {
    return pointerType === 'touch' ? TOUCH_SLOP_PX : pointerType === 'pen' ? PEN_SLOP_PX : 0
  }

  private sendCursorAt(x: number, y: number) {
    this.client.sendCursor(x, y)
    this.cursorSent = true
  }

  /**
   * 내 커서가 아직 다른 사람 화면에 없으면 지금 보고 있는 화면의 한가운데에 둔다.
   * (터치 기기는 조각을 끌기 전까지 커서가 없어서, 채팅을 해도 말풍선이 붙을 자리가 없기 때문이다.)
   */
  announceCursor() {
    if (this.cursorSent || !this.client.puzzle || this.width === 0) return
    const { x, y } = this.toWorld(this.width / 2, this.height / 2)
    this.sendCursorAt(x, y)
  }

  private releaseCapture(pointerId: number) {
    try {
      if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId)
    } catch {
      /* 이미 사라진 포인터 */
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.client.assets || !this.client.puzzle) return
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {
      /* 포인터가 이미 사라졌거나 캡처할 수 없는 환경이어도 입력은 계속 처리한다. */
    }
    // 조각을 들고 있는 동안 닿은 다른 손가락은 확대/이동이 아니라 실수로 닿은 것으로 보고 무시한다.
    if (this.drag?.kind === 'piece') {
      this.ignored.add(e.pointerId)
      return
    }
    const { sx, sy } = this.toScreen(e)
    this.pointers.set(e.pointerId, { x: sx, y: sy })

    // 두 번째 손가락이 닿으면 확대/이동 모드. 하던 화면 끌기는 멈춘다.
    if (this.pointers.size >= 2) {
      this.drag = null
      this.startPinch()
      return
    }

    const { x, y } = this.toWorld(sx, sy)
    if (e.pointerType !== 'mouse') this.sendCursorAt(x, y) // 터치/펜은 닿는 순간부터 다른 사람에게 위치를 보여 준다.

    if (e.button === 0) {
      const id = this.hitTest(x, y, this.slopFor(e.pointerType) / this.cam.scale)
      if (id !== null && this.client.beginGrab(id)) {
        const piece = this.client.pieces[id]
        const lift = e.pointerType === 'touch' ? TOUCH_LIFT_PX / this.cam.scale : 0
        this.drag = { kind: 'piece', id, dx: x - piece.x, dy: y - piece.y + lift }
        this.dragPointer = { x: sx, y: sy, type: e.pointerType }
        this.canvas.style.cursor = 'grabbing'
        if (lift > 0) this.client.dragTo(id, x - this.drag.dx, y - this.drag.dy) // 집자마자 손가락 위로 올라와서 "집었다"는 게 보이게
        return
      }
    }
    // 빈 곳을 끌거나, 가운데/오른쪽 버튼이면 화면 이동
    this.drag = { kind: 'pan', lastX: sx, lastY: sy }
    this.canvas.style.cursor = 'move'
  }

  /** 닿아 있는 손가락 두 개의 간격과 중심 */
  private pinchMetrics() {
    const [a, b] = [...this.pointers.values()]
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
  }

  private startPinch() {
    const { dist, cx, cy } = this.pinchMetrics()
    const { x, y } = this.toWorld(cx, cy)
    this.pinch = { startDist: dist, startScale: this.cam.scale, wx: x, wy: y }
    this.userMoved = true
  }

  /** 두 손가락의 간격에 맞춰 확대하고, 중심이 움직인 만큼 화면도 함께 옮긴다. */
  private updatePinch() {
    const pinch = this.pinch
    if (!pinch) return
    const { dist, cx, cy } = this.pinchMetrics()
    const scale = Math.min(MAX_SCALE, Math.max(this.minScale, (pinch.startScale * dist) / pinch.startDist))
    this.cam.scale = scale
    // 처음에 두 손가락 가운데 있던 월드 좌표가 지금 두 손가락 가운데에 그대로 있도록 한다.
    this.cam.ox = cx - pinch.wx * scale
    this.cam.oy = cy - pinch.wy * scale
    this.userMoved = true
    this.dirty = true
  }

  private onPointerMove = (e: PointerEvent) => {
    const puzzle = this.client.puzzle
    if (!puzzle || !this.client.assets) return
    if (this.ignored.has(e.pointerId)) return
    const { sx, sy } = this.toScreen(e)
    this.hover = { x: sx, y: sy }
    const tracked = this.pointers.get(e.pointerId)
    if (tracked) {
      tracked.x = sx
      tracked.y = sy
    }
    if (this.pinch && this.pointers.size >= 2) {
      this.updatePinch()
      return
    }
    const { x, y } = this.toWorld(sx, sy)
    this.sendCursorAt(x, y)

    const drag = this.drag
    if (drag?.kind === 'piece') {
      if (this.client.myHeld !== drag.id) {
        // 다른 사람이 먼저 잡았다 → 내 드래그 취소
        this.drag = null
        this.dragPointer = null
        this.canvas.style.cursor = 'default'
        return
      }
      if (this.dragPointer) {
        this.dragPointer.x = sx
        this.dragPointer.y = sy
      }
      // 테이블 밖으로 나가지 않도록 하는 제한은 덩어리 크기를 아는 GameClient가 처리한다.
      this.client.dragTo(drag.id, x - drag.dx, y - drag.dy)
    } else if (drag?.kind === 'pan') {
      this.userMoved = true
      this.cam.ox += sx - drag.lastX
      this.cam.oy += sy - drag.lastY
      drag.lastX = sx
      drag.lastY = sy
      this.dirty = true
    } else if (e.pointerType === 'mouse') {
      this.canvas.style.cursor = this.hitTest(x, y) !== null ? 'grab' : 'default'
    }
  }

  private onPointerLeave = () => {
    this.hover = null
  }

  /**
   * 마우스가 올라가 있는 퍼즐판 자리에 들어갈 조각이 지금 어디 있는지 반짝여서 알려 준다. (나한테만 보인다)
   * 퍼즐판 밖이거나 마우스가 없으면 false.
   */
  locateAtPointer(): boolean {
    const puzzle = this.client.puzzle
    if (!puzzle || !this.hover || this.client.pieces.length === 0) return false
    const { x, y } = this.toWorld(this.hover.x, this.hover.y)
    const { cols, rows, imageWidth: W, imageHeight: H } = puzzle
    if (x < 0 || y < 0 || x >= W || y >= H) return false
    const id = Math.floor(y / (H / rows)) * cols + Math.floor(x / (W / cols))
    this.locating = { id, at: performance.now() }
    this.dirty = true
    return true
  }

  private onPointerUp = (e: PointerEvent) => {
    if (this.ignored.delete(e.pointerId)) {
      this.releaseCapture(e.pointerId)
      return
    }
    if (!this.pointers.has(e.pointerId)) return // 처음부터 추적하지 않던 포인터 (예: 불러오는 중에 닿은 것)
    this.pointers.delete(e.pointerId)
    this.releaseCapture(e.pointerId)
    this.canvas.style.cursor = 'default'

    if (this.pinch) {
      // 두 손가락 중 하나를 떼면 확대는 끝난다. 남은 손가락으로는 이어서 화면을 끌 수 있게 해서 화면이 튀지 않게 한다.
      if (this.pointers.size < 2) {
        this.pinch = null
        const rest = [...this.pointers.values()][0]
        this.drag = rest ? { kind: 'pan', lastX: rest.x, lastY: rest.y } : null
      }
      return
    }

    const drag = this.drag
    this.drag = null
    this.dragPointer = null
    if (drag?.kind === 'piece' && this.client.myHeld === drag.id) {
      this.client.endDrag(drag.id)
    }
  }

  /**
   * 손가락(펜)으로 조각을 끌다가 가장자리에 가까워지면 화면을 그쪽으로 옮긴다.
   * 화면이 작으면 조각을 놓았다가 화면을 밀고 다시 집는 일을 반복해야 하기 때문이다. (마우스는 휠/드래그가 있어서 쓰지 않는다.)
   * 화면 가장자리가 이미 테이블 밖이면 더는 밀지 않는다. 움직였으면 true.
   */
  private autoPan(dt: number): boolean {
    const drag = this.drag
    const pointer = this.dragPointer
    const puzzle = this.client.puzzle
    if (drag?.kind !== 'piece' || !pointer || pointer.type === 'mouse' || !puzzle) return false
    const zone = EDGE_PAN_ZONE_PX
    // 가장자리로 갈수록 1에 가까워지는 값. 화면이 움직이는 방향은 가장자리의 반대쪽이다.
    const push = (pos: number, size: number) => (pos < zone ? (zone - pos) / zone : pos > size - zone ? -(pos - (size - zone)) / zone : 0)
    let vx = push(pointer.x, this.width)
    let vy = push(pointer.y, this.height)
    if (vx === 0 && vy === 0) return false

    const { bounds } = puzzle
    const s = this.cam.scale
    const left = -this.cam.ox / s
    const right = (this.width - this.cam.ox) / s
    const top = -this.cam.oy / s
    const bottom = (this.height - this.cam.oy) / s
    if ((vx > 0 && left <= bounds.minX) || (vx < 0 && right >= bounds.maxX)) vx = 0
    if ((vy > 0 && top <= bounds.minY) || (vy < 0 && bottom >= bounds.maxY)) vy = 0
    if (vx === 0 && vy === 0) return false

    this.cam.ox += Math.min(1, Math.abs(vx)) * Math.sign(vx) * EDGE_PAN_SPEED * dt
    this.cam.oy += Math.min(1, Math.abs(vy)) * Math.sign(vy) * EDGE_PAN_SPEED * dt
    this.userMoved = true
    this.dirty = true
    // 손가락은 그대로인데 화면이 움직였으니, 들고 있는 조각도 손가락 아래(위로 띄운 만큼 위)로 따라가게 한다.
    const { x, y } = this.toWorld(pointer.x, pointer.y)
    this.client.dragTo(drag.id, x - drag.dx, y - drag.dy)
    return true
  }

  /**
   * 고정된 조각 중 제자리에 도착한 것을 레이어에 그려 넣는다. (아직 제자리로 움직이는 중인 조각은 다음 프레임에)
   * 고정된 조각은 다시 풀리지 않으니 한 번 넣으면 끝이다. 만약 풀린 조각이 보이면 레이어를 처음부터 다시 만든다.
   */
  private syncLockedLayer(
    pieces: ClientPiece[],
    bitmaps: HTMLCanvasElement[],
    W: number,
    H: number,
    pad: number,
  ): LockedLayer | null {
    let layer = this.lockedLayer
    let stale = false
    for (const p of pieces) {
      if (!p.locked) {
        if (layer && layer.baked[p.id]) stale = true
        continue
      }
      if (layer && layer.baked[p.id]) continue
      if (p.x !== p.tx || p.y !== p.ty) continue
      if (!layer) {
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(W + pad * 2)
        canvas.height = Math.ceil(H + pad * 2)
        layer = this.lockedLayer = { canvas, ctx: canvas.getContext('2d')!, baked: new Uint8Array(pieces.length), count: 0 }
      }
      layer.ctx.drawImage(bitmaps[p.id], p.x, p.y) // 레이어의 (0,0)이 월드 (-pad,-pad)이므로 조각 그림은 (x, y)에 놓인다.
      layer.baked[p.id] = 1
      layer.count++
    }
    if (stale && layer) {
      this.lockedLayer = null // 일어나지 않을 일이지만, 풀린 조각이 있으면 처음부터 다시 만든다.
      return this.syncLockedLayer(pieces, bitmaps, W, H, pad)
    }
    return layer
  }

  /**
   * 월드 좌표 (wx, wy) 위에 있는, 내가 집을 수 있는 가장 위쪽 조각.
   * 조각 위가 아니어도 slop(월드 단위) 안에 조각 윤곽이 있으면, 그중 중심이 가장 가까운 조각을 돌려준다. (손가락은 정확히 못 누른다)
   */
  private hitTest(wx: number, wy: number, slop = 0): number | null {
    const assets = this.client.assets
    if (!assets) return null
    const { geo } = assets
    const me = this.client.meId
    for (let i = this.drawOrder.length - 1; i >= 0; i--) {
      const piece = this.client.pieces[this.drawOrder[i]]
      if (piece.locked || (piece.heldBy !== null && piece.heldBy !== me)) continue
      const lx = wx - piece.x
      const ly = wy - piece.y
      if (lx < -geo.pad || ly < -geo.pad || lx > geo.pw + geo.pad || ly > geo.ph + geo.pad) continue
      if (this.hitCtx.isPointInPath(geo.paths[piece.id], lx, ly)) return piece.id
    }
    if (slop <= 0) return null

    const hc = this.hitCtx
    hc.lineWidth = slop * 2 // 윤곽선을 이만큼 두껍게 쳤을 때 그 안에 들어오면 "근처"다.
    hc.lineJoin = 'round'
    let best: number | null = null
    let bestDist = Infinity
    for (let i = this.drawOrder.length - 1; i >= 0; i--) {
      const piece = this.client.pieces[this.drawOrder[i]]
      if (piece.locked || (piece.heldBy !== null && piece.heldBy !== me)) continue
      const lx = wx - piece.x
      const ly = wy - piece.y
      if (lx < -geo.pad - slop || ly < -geo.pad - slop || lx > geo.pw + geo.pad + slop || ly > geo.ph + geo.pad + slop) continue
      if (!hc.isPointInStroke(geo.paths[piece.id], lx, ly)) continue
      const d = Math.hypot(lx - geo.pw / 2, ly - geo.ph / 2)
      if (d < bestDist) {
        bestDist = d
        best = piece.id
      }
    }
    return best
  }

  // ---------- 렌더링 ----------
  private frame = (t: number) => {
    this.raf = requestAnimationFrame(this.frame)
    const dt = Math.max(0, Math.min(0.1, (t - this.lastTime) / 1000)) // 시각이 거꾸로 가는 일이 있어도 화면이 반대로 튀지 않게
    this.lastTime = t
    const panned = this.autoPan(dt)
    const moving = this.client.step(dt) || panned // 상태 갱신은 매 프레임 하지만(싸다), 그리기는 바뀐 게 있을 때만 한다.
    if (this.needsRedraw(performance.now(), moving)) this.draw()
  }

  /** 마지막으로 그린 뒤로 화면에 보이는 무언가가 바뀌었는지 */
  private needsRedraw(now: number, moving: boolean): boolean {
    if (moving || this.dirty) return true
    if (this.client.revision !== this.seenRevision) return true // 서버 소식, 내가 잡거나 옮긴 조각, 접속 상태 …
    if (this.client.effects.length > 0) return true // 붙을 때 반짝이는 효과
    if (this.locating) return true // "C"로 찾은 조각이 반짝이는 중
    if (now - this.lastDrawAt >= IDLE_REDRAW_MS) return true // 안전장치
    // 시간이 지나서 저절로 바뀌는 것: 말풍선이 흐려지는 중이거나, 커서가 한동안 안 움직여서 흐려질 때
    for (const pl of this.client.players.values()) {
      if (pl.info.id === this.client.meId || !pl.hasCursor) continue
      if (pl.chat) return true
      const idleNow = now - pl.lastSeen > CURSOR_IDLE_MS
      if (idleNow !== (this.cursorIdleDrawn.get(pl.info.id) ?? false)) return true
    }
    return false
  }

  private draw() {
    this.dirty = false
    this.seenRevision = this.client.revision
    this.lastDrawAt = performance.now()

    // 새 퍼즐(사진/격자가 다름)이 시작되면 처음 들어왔을 때처럼 전체가 한눈에 보이게 다시 맞춘다.
    // 캔버스 크기를 바꾸면 그리기 상태가 초기화되므로 이 프레임의 그리기를 시작하기 전에 한다.
    const assets = this.client.assets
    if (assets && assets !== this.lastAssets) {
      this.lastAssets = assets
      this.resize() // 조각 수가 정해졌으니 캔버스 해상도 상한도 다시 정한다.
      this.fitted = false
      this.drag = null
      this.lockedLayer = null // 이전 퍼즐의 고정 조각 그림은 버린다.
    }

    const { ctx, dpr } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0d1018'
    ctx.fillRect(0, 0, this.width, this.height)

    const puzzle = this.client.puzzle
    if (!puzzle || !assets || this.width === 0) return
    if (!this.fitted) this.fit()

    const { scale, ox, oy } = this.cam
    const { bounds, imageWidth: W, imageHeight: H, cols, rows } = puzzle
    const { geo, bitmaps } = assets
    const pieces = this.client.pieces
    const players = this.client.players

    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy)
    ctx.imageSmoothingQuality = 'high'

    // 테이블
    ctx.fillStyle = '#171c2a'
    ctx.fillRect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
    ctx.lineWidth = 2 / scale
    ctx.strokeStyle = '#2a3350'
    ctx.strokeRect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)

    // 보드 (조각이 들어갈 자리)
    ctx.fillStyle = '#212940'
    ctx.fillRect(0, 0, W, H)
    if (this.showGhost) {
      ctx.globalAlpha = 0.28
      ctx.drawImage(assets.image, 0, 0, W, H)
      ctx.globalAlpha = 1
    }
    ctx.beginPath()
    for (let c = 1; c < cols; c++) {
      ctx.moveTo((W * c) / cols, 0)
      ctx.lineTo((W * c) / cols, H)
    }
    for (let r = 1; r < rows; r++) {
      ctx.moveTo(0, (H * r) / rows)
      ctx.lineTo(W, (H * r) / rows)
    }
    ctx.lineWidth = 1 / scale
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.stroke()
    ctx.lineWidth = 2 / scale
    ctx.strokeStyle = '#4b5a82'
    ctx.strokeRect(0, 0, W, H)

    // 조각 그리기용 보간 화질. 판 배경/원본 힌트는 위에서 고화질로 이미 그렸다.
    const pieceQuality: ImageSmoothingQuality =
      pieces.length > HEAVY_PIECE_COUNT && dpr * scale < DOWNSCALE_SLOW_BELOW ? 'low' : 'high'

    // 화면 밖 조각은 그리지 않는다. (조각 그림의 여백과 그림자/테두리가 번지는 만큼 여유를 둔다)
    const reach = geo.pad + 24 / scale
    const viewL = -ox / scale - geo.pw - reach
    const viewR = (this.width - ox) / scale + reach
    const viewT = -oy / scale - geo.ph - reach
    const viewB = (this.height - oy) / scale + reach
    const onScreen = (p: ClientPiece) => p.x > viewL && p.x < viewR && p.y > viewT && p.y < viewB

    // 맞춰진 조각 (맨 아래). 많이 줄여서 보는 중이면 미리 모아 둔 레이어 한 장으로 그린다.
    const layer = this.syncLockedLayer(pieces, bitmaps, W, H, geo.pad)
    const useLayer = layer !== null && layer.count > 0 && dpr * scale < LAYER_BELOW_SCALE
    if (useLayer) {
      const pad = geo.pad
      const sx = Math.max(0, Math.floor(-ox / scale + pad))
      const sy = Math.max(0, Math.floor(-oy / scale + pad))
      const sw = Math.min(layer.canvas.width, Math.ceil((this.width - ox) / scale + pad)) - sx
      const sh = Math.min(layer.canvas.height, Math.ceil((this.height - oy) / scale + pad)) - sy
      if (sw > 0 && sh > 0) {
        // 낮은 화질로 그린다. 조각 개별로 그릴 때(낮은 화질)와 눈에 띄는 차이가 없고, 높은 화질은 다른 조각과 섞어 그릴 때 훨씬 느렸다.
        ctx.imageSmoothingQuality = 'low'
        ctx.drawImage(layer.canvas, sx, sy, sw, sh, sx - pad, sy - pad, sw, sh)
      }
    }
    ctx.imageSmoothingQuality = pieceQuality
    for (const p of pieces) {
      if (!p.locked || !onScreen(p)) continue
      if (useLayer && layer.baked[p.id]) continue // 이미 레이어에 들어 있다.
      ctx.drawImage(bitmaps[p.id], p.x - geo.pad, p.y - geo.pad)
    }

    // 떠 있는 조각 (z 순서). 이어 붙은 조각은 z가 같아서 한 덩어리로 연달아 그려진다.
    const free = pieces
      .filter((p) => !p.locked)
      .sort((a, b) => a.z - b.z || a.group - b.group || a.id - b.id)
    this.drawOrder = free.map((p) => p.id)
    for (let i = 0; i < free.length; ) {
      let j = i
      while (j < free.length && free[j].group === free[i].group) j++
      const run = free.slice(i, j)
      i = j

      const holder = run[0].heldBy ? players.get(run[0].heldBy) : undefined
      if (run[0].heldBy && run.length <= SHADOW_MAX_PIECES) {
        // 그림자는 덩어리 전체에 대해 먼저 따로 그린다. (조각 사이 이음새에 그림자가 비쳐 보이지 않게)
        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,0.55)'
        ctx.shadowBlur = 16 * dpr
        ctx.shadowOffsetY = 6 * dpr
        for (const p of run) if (onScreen(p)) ctx.drawImage(bitmaps[p.id], p.x - geo.pad, p.y - geo.pad)
        ctx.restore()
      }
      for (const p of run) if (onScreen(p)) ctx.drawImage(bitmaps[p.id], p.x - geo.pad, p.y - geo.pad)

      if (holder) {
        // 누가 들고 있는지 덩어리의 "바깥 테두리"만 색으로 표시
        ctx.save()
        ctx.lineWidth = 3 / scale
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.strokeStyle = holder.info.color
        for (const p of run) {
          if (!onScreen(p)) continue
          const r = Math.floor(p.id / cols)
          const c = p.id % cols
          ctx.save()
          ctx.translate(p.x, p.y)
          SIDES.forEach((side, s) => {
            const nr = r + side.dr
            const nc = c + side.dc
            const inside = nr >= 0 && nr < rows && nc >= 0 && nc < cols
            if (inside && pieces[nr * cols + nc].group === p.group) return
            ctx.stroke(geo.edgePaths[p.id][s])
          })
          ctx.restore()
        }
        ctx.restore()
      }
    }

    // 붙는 순간 반짝임
    const now = performance.now()
    const effects = (this.client.effects = this.client.effects.filter((e) => now - e.at < FLASH_MS))
    for (const e of effects) {
      const t = (now - e.at) / FLASH_MS
      ctx.save()
      ctx.globalAlpha = (1 - t) * 0.9
      ctx.strokeStyle = e.kind === 'board' ? '#ffe27a' : '#ffffff'
      ctx.lineWidth = (2.5 + 4 * t) / scale
      ctx.lineJoin = 'round'
      for (const id of e.ids) {
        ctx.save()
        ctx.translate(pieces[id].x, pieces[id].y)
        ctx.stroke(geo.paths[id])
        ctx.restore()
      }
      ctx.restore()
    }

    // "C"로 찾은 조각: 노랗게 깜빡인다. 화면 밖에 있으면 아래에서 방향 표시를 그린다.
    let locateOff: { sx: number; sy: number; pulse: number } | null = null
    if (this.locating) {
      const age = now - this.locating.at
      const piece = pieces[this.locating.id]
      if (age >= LOCATE_MS || !piece) {
        this.locating = null
      } else {
        const pulse = 0.5 + 0.5 * Math.sin((age / 1000) * Math.PI * 2 * 2.5 - Math.PI / 2) // 초당 2.5번 깜빡
        const fade = Math.min(1, (LOCATE_MS - age) / 500)
        ctx.save()
        ctx.translate(piece.x, piece.y)
        ctx.globalAlpha = (0.25 + 0.5 * pulse) * fade
        ctx.fillStyle = '#fff3a8'
        ctx.fill(geo.paths[piece.id])
        ctx.globalAlpha = (0.55 + 0.45 * pulse) * fade
        ctx.strokeStyle = '#ffd43b'
        ctx.lineWidth = 4 / scale
        ctx.lineJoin = 'round'
        ctx.stroke(geo.paths[piece.id])
        ctx.restore()
        const sx = (piece.x + geo.pw / 2) * scale + ox
        const sy = (piece.y + geo.ph / 2) * scale + oy
        if (sx < 0 || sy < 0 || sx > this.width || sy > this.height) locateOff = { sx, sy, pulse: pulse * fade }
      }
    }

    // 다른 사람 커서 (화면 크기 기준으로 그린다)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (locateOff) {
      // 화면 가운데에서 조각 쪽으로 향하는 화살표를 화면 가장자리에 놓는다.
      const cx = this.width / 2
      const cy = this.height / 2
      const dx = locateOff.sx - cx
      const dy = locateOff.sy - cy
      const m = 34
      const k = Math.min((cx - m) / Math.abs(dx || 1e-6), (cy - m) / Math.abs(dy || 1e-6))
      ctx.save()
      ctx.translate(cx + dx * k, cy + dy * k)
      ctx.rotate(Math.atan2(dy, dx))
      ctx.globalAlpha = 0.6 + 0.4 * locateOff.pulse
      ctx.fillStyle = '#ffd43b'
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'
      ctx.lineWidth = 2
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(18, 0)
      ctx.lineTo(-10, -14)
      ctx.lineTo(-4, 0)
      ctx.lineTo(-10, 14)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
    for (const pl of players.values()) {
      if (pl.info.id === this.client.meId || !pl.hasCursor) continue
      const idle = now - pl.lastSeen > CURSOR_IDLE_MS
      this.cursorIdleDrawn.set(pl.info.id, idle)

      // 커서 옆 채팅은 마지막으로 글이 바뀐 뒤 시간이 지나면 흐려지다가 사라진다.
      let chat: { text: string; alpha: number } | null = null
      if (pl.chat) {
        const alpha = chatOpacity(now - pl.chat.at)
        if (alpha > 0) chat = { text: pl.chat.text, alpha }
        else pl.chat = null
      }
      this.drawCursor(pl.x * scale + ox, pl.y * scale + oy, pl.info.name, pl.info.color, idle ? 0.35 : 1, chat)
    }
  }

  private drawCursor(
    x: number,
    y: number,
    name: string,
    color: string,
    alpha: number,
    chat: { text: string; alpha: number } | null,
  ) {
    const { ctx } = this
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.translate(x, y)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(0, 17)
    ctx.lineTo(4.5, 13.2)
    ctx.lineTo(7.5, 20)
    ctx.lineTo(10.3, 18.8)
    ctx.lineTo(7.4, 12.3)
    ctx.lineTo(13, 12.3)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.stroke()
    ctx.fill()

    ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif'
    const w = ctx.measureText(name).width + 14
    ctx.beginPath()
    roundRectPath(ctx, 11, 19, w, 20, 10)
    ctx.fillStyle = color
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.textBaseline = 'middle'
    ctx.fillText(name, 18, 29.5)

    if (chat) {
      // 이름표 아래에 말풍선. 화면 오른쪽 끝에 닿으면 왼쪽으로 밀어서 잘리지 않게 한다.
      ctx.font = '600 13px system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif'
      const bw = Math.max(40, ctx.measureText(chat.text).width + 26)
      const bx = Math.min(11, this.width - 8 - x - bw)
      ctx.globalAlpha = alpha * chat.alpha
      ctx.beginPath()
      roundRectPath(ctx, bx, 44, bw, 28, 14)
      ctx.fillStyle = color
      ctx.fill()
      ctx.lineWidth = 1.5
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.fillText(chat.text, bx + 13, 58.5)
    }
    ctx.restore()
  }
}
