import type { PuzzleConfig } from '../../shared/protocol'

// ------------------------------------------------------------------
// 직소 퍼즐 조각 모양 생성
//  - 시드 기반이라 모든 클라이언트에서 완전히 같은 모양이 나온다.
//  - 이웃한 두 조각은 같은 곡선을 공유하므로 요철이 정확히 맞물린다.
// ------------------------------------------------------------------

type Pt = [number, number]
/** 베지어 곡선 3개(점 10개). 변이 평평하면 null */
type Edge = Pt[] | null

export function mulberry32(seed: number) {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 길이 1짜리 변 하나. x는 변을 따라 0→1, y는 변에 수직(± 방향이 요/철).
 * 점 p0..p9 = 3개의 3차 베지어 (p0,p1,p2,p3) (p3,p4,p5,p6) (p6,p7,p8,p9)
 */
function makeEdge(rng: () => number): Pt[] {
  const J = 0.04
  const jitter = () => (rng() * 2 - 1) * J
  const sign = rng() < 0.5 ? -1 : 1
  const t = 0.1 * (0.92 + rng() * 0.2) // 돌기 크기
  const a = jitter()
  const b = jitter()
  const c = jitter()
  const d = jitter()
  const e = jitter()
  const pts: Pt[] = [
    [0, 0],
    [0.2, a],
    [0.5 + b + d, -t + c],
    [0.5 - t + b + d, t + c],
    [0.5 - 2 * t + b - d, 3 * t + c],
    [0.5 + 2 * t + b - d, 3 * t + c],
    [0.5 + t + b + d, t + c],
    [0.5 + b + d, -t + c],
    [0.8, e],
    [1, 0],
  ]
  return pts.map(([x, y]) => [x, y * sign] as Pt)
}

/** 변 번호: 0=위, 1=오른쪽, 2=아래, 3=왼쪽 */
export const SIDES = [
  { dr: -1, dc: 0 },
  { dr: 0, dc: 1 },
  { dr: 1, dc: 0 },
  { dr: 0, dc: -1 },
] as const

export interface PieceGeometry {
  /** 조각 셀의 왼쪽 위를 (0,0)으로 하는 외곽선 */
  paths: Path2D[]
  /** 조각마다 변 4개를 따로 만든 경로 (SIDES 순서). 덩어리의 바깥 테두리만 그릴 때 쓴다. */
  edgePaths: Path2D[][]
  /** 셀 바깥으로 튀어나온 돌기를 담기 위한 여백 */
  pad: number
  pw: number
  ph: number
}

type GridDims = Pick<PuzzleConfig, 'cols' | 'rows' | 'imageWidth' | 'imageHeight' | 'seed'>

export function buildGeometry(p: GridDims): PieceGeometry {
  const { cols, rows, seed } = p
  const pw = p.imageWidth / cols
  const ph = p.imageHeight / rows
  const rng = mulberry32(seed)

  // H[r][c]: r번째 가로선의 c번째 칸 (r=0..rows), V[r][c]: r번째 줄의 c번째 세로선 (c=0..cols)
  const H: Edge[][] = []
  for (let r = 0; r <= rows; r++) {
    const line: Edge[] = []
    for (let c = 0; c < cols; c++) line.push(r === 0 || r === rows ? null : makeEdge(rng))
    H.push(line)
  }
  const V: Edge[][] = []
  for (let r = 0; r < rows; r++) {
    const line: Edge[] = []
    for (let c = 0; c <= cols; c++) line.push(c === 0 || c === cols ? null : makeEdge(rng))
    V.push(line)
  }

  /** 변을 path에 이어 붙인다. 현재 점은 변의 시작점(reverse면 끝점)이어야 한다. */
  const addEdge = (path: Path2D, edge: Edge, map: (pt: Pt) => Pt, endOfFlat: Pt, reverse: boolean) => {
    if (!edge) {
      path.lineTo(endOfFlat[0], endOfFlat[1])
      return
    }
    const q = edge.map(map)
    if (!reverse) {
      path.bezierCurveTo(q[1][0], q[1][1], q[2][0], q[2][1], q[3][0], q[3][1])
      path.bezierCurveTo(q[4][0], q[4][1], q[5][0], q[5][1], q[6][0], q[6][1])
      path.bezierCurveTo(q[7][0], q[7][1], q[8][0], q[8][1], q[9][0], q[9][1])
    } else {
      path.bezierCurveTo(q[8][0], q[8][1], q[7][0], q[7][1], q[6][0], q[6][1])
      path.bezierCurveTo(q[5][0], q[5][1], q[4][0], q[4][1], q[3][0], q[3][1])
      path.bezierCurveTo(q[2][0], q[2][1], q[1][0], q[1][1], q[0][0], q[0][1])
    }
  }

  const paths: Path2D[] = []
  const edgePaths: Path2D[][] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // 네 변의 정의 (SIDES 순서). 전체 외곽선과 변별 경로를 모두 이 정의로 만든다.
      const specs: { edge: Edge; map: (pt: Pt) => Pt; start: Pt; end: Pt; reverse: boolean }[] = [
        // 위쪽 변: 왼→오 (법선 +y = 아래로)
        { edge: H[r][c], map: ([x, y]) => [x * pw, y * pw], start: [0, 0], end: [pw, 0], reverse: false },
        // 오른쪽 변: 위→아래 (법선 +x = 오른쪽)
        { edge: V[r][c + 1], map: ([x, y]) => [pw + y * ph, x * ph], start: [pw, 0], end: [pw, ph], reverse: false },
        // 아래쪽 변: 오→왼 (같은 곡선을 거꾸로)
        { edge: H[r + 1][c], map: ([x, y]) => [x * pw, ph + y * pw], start: [pw, ph], end: [0, ph], reverse: true },
        // 왼쪽 변: 아래→위
        { edge: V[r][c], map: ([x, y]) => [y * ph, x * ph], start: [0, ph], end: [0, 0], reverse: true },
      ]

      const path = new Path2D()
      path.moveTo(0, 0)
      for (const s of specs) addEdge(path, s.edge, s.map, s.end, s.reverse)
      path.closePath()
      paths.push(path)

      edgePaths.push(
        specs.map((s) => {
          const p = new Path2D()
          p.moveTo(s.start[0], s.start[1])
          addEdge(p, s.edge, s.map, s.end, s.reverse)
          return p
        }),
      )
    }
  }

  const pad = Math.ceil(0.34 * Math.max(pw, ph)) + 3
  return { paths, edgePaths, pad, pw, ph }
}

/** 조각마다 (이미지 일부 + 테두리)를 미리 그려둔 비트맵을 만든다. 렌더링 때는 drawImage만 하면 된다. */
export function renderPieceBitmaps(
  img: CanvasImageSource,
  p: Pick<PuzzleConfig, 'cols' | 'rows'>,
  geo: PieceGeometry,
): HTMLCanvasElement[] {
  const { pw, ph, pad } = geo
  const w = Math.ceil(pw + pad * 2)
  const h = Math.ceil(ph + pad * 2)
  const out: HTMLCanvasElement[] = []
  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < p.cols; c++) {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')!
      const path = geo.paths[r * p.cols + c]
      ctx.translate(pad, pad)

      // 1) 조각 모양으로 잘라낸 이미지
      ctx.save()
      ctx.clip(path)
      ctx.drawImage(img, -c * pw, -r * ph)
      // 안쪽 하이라이트 (입체감)
      ctx.lineJoin = 'round'
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'
      ctx.stroke(path)
      ctx.restore()

      // 2) 바깥 윤곽선
      ctx.lineJoin = 'round'
      ctx.lineWidth = 1.2
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'
      ctx.stroke(path)
      out.push(canvas)
    }
  }
  return out
}
