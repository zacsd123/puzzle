import type { GameClient } from './GameClient'
import { SIDES } from './jigsaw'

/** 조각이 붙을 때 반짝이는 시간(ms) */
const FLASH_MS = 550

// ---- 조각이 많을 때의 렌더링 비용 조절 ----
// (측정: 1000조각을 절반 이하로 줄여 그리면 고화질 보간은 프레임당 300ms+, 낮은 화질 보간은 20ms 안팎)
/** 이 수보다 조각이 많고 많이 축소해서 보는 중이면 가벼운 보간으로 그린다. */
const HEAVY_PIECE_COUNT = 150
/** 실제 화면 배율(줌 × 화면 배율)이 이보다 작으면 브라우저가 느린 축소 보간 경로를 탄다. */
const DOWNSCALE_SLOW_BELOW = 0.5
/** 들고 있는 덩어리의 그림자는 조각마다 흐림 효과를 따로 계산해서, 큰 덩어리는 그림자를 생략한다. */
const SHADOW_MAX_PIECES = 60

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
  private raf = 0
  private lastTime = 0
  private ro: ResizeObserver
  /** 마지막으로 그린 자유 조각들 (z 오름차순). 히트 테스트에서 위에 있는 조각부터 검사하는 데 쓴다. */
  private drawOrder: number[] = []

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
    canvas.addEventListener('mousedown', this.onMouseDown)

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    this.resize()
    this.raf = requestAnimationFrame(this.frame)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    const c = this.canvas
    c.removeEventListener('pointerdown', this.onPointerDown)
    c.removeEventListener('pointermove', this.onPointerMove)
    c.removeEventListener('pointerup', this.onPointerUp)
    c.removeEventListener('pointercancel', this.onPointerUp)
    c.removeEventListener('wheel', this.onWheel)
    c.removeEventListener('contextmenu', this.preventDefault)
    c.removeEventListener('mousedown', this.onMouseDown)
  }

  // ---------- 공개 API (HUD 버튼용) ----------
  setGhost(on: boolean) {
    this.showGhost = on
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
  }

  zoomBy(factor: number) {
    this.userMoved = true
    this.zoomAt(this.width / 2, this.height / 2, this.cam.scale * factor)
  }

  // ---------- 크기/좌표 ----------
  private resize() {
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    this.dpr = window.devicePixelRatio || 1
    const hadSize = this.width > 0
    const prevW = this.width
    const prevH = this.height
    this.width = w
    this.height = h
    this.canvas.width = Math.max(1, Math.round(w * this.dpr))
    this.canvas.height = Math.max(1, Math.round(h * this.dpr))
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

  private onPointerDown = (e: PointerEvent) => {
    if (!this.client.assets || !this.client.puzzle) return
    this.canvas.setPointerCapture(e.pointerId)
    const { sx, sy } = this.toScreen(e)
    const { x, y } = this.toWorld(sx, sy)

    if (e.button === 0) {
      const id = this.hitTest(x, y)
      if (id !== null && this.client.beginGrab(id)) {
        const piece = this.client.pieces[id]
        this.drag = { kind: 'piece', id, dx: x - piece.x, dy: y - piece.y }
        this.canvas.style.cursor = 'grabbing'
        return
      }
    }
    // 빈 곳을 끌거나, 가운데/오른쪽 버튼이면 화면 이동
    this.drag = { kind: 'pan', lastX: sx, lastY: sy }
    this.canvas.style.cursor = 'move'
  }

  private onPointerMove = (e: PointerEvent) => {
    const puzzle = this.client.puzzle
    if (!puzzle || !this.client.assets) return
    const { sx, sy } = this.toScreen(e)
    const { x, y } = this.toWorld(sx, sy)
    this.client.sendCursor(x, y)

    const drag = this.drag
    if (drag?.kind === 'piece') {
      if (this.client.myHeld !== drag.id) {
        // 다른 사람이 먼저 잡았다 → 내 드래그 취소
        this.drag = null
        this.canvas.style.cursor = 'default'
        return
      }
      // 테이블 밖으로 나가지 않도록 하는 제한은 덩어리 크기를 아는 GameClient가 처리한다.
      this.client.dragTo(drag.id, x - drag.dx, y - drag.dy)
    } else if (drag?.kind === 'pan') {
      this.userMoved = true
      this.cam.ox += sx - drag.lastX
      this.cam.oy += sy - drag.lastY
      drag.lastX = sx
      drag.lastY = sy
    } else {
      this.canvas.style.cursor = this.hitTest(x, y) !== null ? 'grab' : 'default'
    }
  }

  private onPointerUp = (e: PointerEvent) => {
    const drag = this.drag
    this.drag = null
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
    this.canvas.style.cursor = 'default'
    if (drag?.kind === 'piece' && this.client.myHeld === drag.id) {
      this.client.endDrag(drag.id)
    }
  }

  /** 월드 좌표 (wx, wy) 위에 있는, 내가 집을 수 있는 가장 위쪽 조각 */
  private hitTest(wx: number, wy: number): number | null {
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
    return null
  }

  // ---------- 렌더링 ----------
  private frame = (t: number) => {
    this.raf = requestAnimationFrame(this.frame)
    const dt = Math.min(0.1, (t - this.lastTime) / 1000)
    this.lastTime = t
    this.client.step(dt)
    this.draw()
  }

  private draw() {
    const { ctx, dpr } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0d1018'
    ctx.fillRect(0, 0, this.width, this.height)

    const puzzle = this.client.puzzle
    const assets = this.client.assets
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
    ctx.imageSmoothingQuality =
      pieces.length > HEAVY_PIECE_COUNT && dpr * scale < DOWNSCALE_SLOW_BELOW ? 'low' : 'high'

    // 맞춰진 조각 (맨 아래)
    for (const p of pieces) {
      if (p.locked) ctx.drawImage(bitmaps[p.id], p.x - geo.pad, p.y - geo.pad)
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
        for (const p of run) ctx.drawImage(bitmaps[p.id], p.x - geo.pad, p.y - geo.pad)
        ctx.restore()
      }
      for (const p of run) ctx.drawImage(bitmaps[p.id], p.x - geo.pad, p.y - geo.pad)

      if (holder) {
        // 누가 들고 있는지 덩어리의 "바깥 테두리"만 색으로 표시
        ctx.save()
        ctx.lineWidth = 3 / scale
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.strokeStyle = holder.info.color
        for (const p of run) {
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

    // 다른 사람 커서 (화면 크기 기준으로 그린다)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    for (const pl of players.values()) {
      if (pl.info.id === this.client.meId || !pl.hasCursor) continue
      const idle = now - pl.lastSeen > 6000
      this.drawCursor(pl.x * scale + ox, pl.y * scale + oy, pl.info.name, pl.info.color, idle ? 0.35 : 1)
    }
  }

  private drawCursor(x: number, y: number, name: string, color: string, alpha: number) {
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
    ctx.roundRect(11, 19, w, 20, 10)
    ctx.fillStyle = color
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.textBaseline = 'middle'
    ctx.fillText(name, 18, 29.5)
    ctx.restore()
  }
}
