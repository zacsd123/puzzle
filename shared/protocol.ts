// 클라이언트와 서버가 공유하는 타입/상수.
// 좌표는 모두 "월드 좌표"(= 원본 이미지 픽셀 단위)이고, 퍼즐판(보드)의 왼쪽 위가 (0, 0)이다.
// 각 플레이어의 줌/스크롤은 로컬 화면에서만 적용되므로, 월드 좌표로 주고받으면
// 화면 크기가 달라도 커서/조각 위치가 정확히 일치한다.

export const MAX_NAME_LENGTH = 16
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MIN_GRID = 2
export const MAX_GRID = 25
export const MAX_PIECES = 400
export const ROOM_CODE_LENGTH = 5
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 조각이 정답 위치에서 (짧은 변 × 이 비율) 이내로 떨어지면 자동으로 맞춰진다. */
export const SNAP_RATIO = 0.3

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface PuzzleConfig {
  roomId: string
  cols: number
  rows: number
  /** 원본(리사이즈된) 이미지 크기. 보드 크기와 같다. */
  imageWidth: number
  imageHeight: number
  /** 조각 모양을 모든 클라이언트에서 똑같이 만들기 위한 시드 */
  seed: number
  /** 조각이 돌아다닐 수 있는 테이블 범위 (보드를 포함) */
  bounds: Bounds
  imageUrl: string
}

export interface PieceState {
  /** row * cols + col */
  id: number
  /** 조각 셀의 왼쪽 위 월드 좌표 */
  x: number
  y: number
  /** 그리는 순서 (클수록 위) */
  z: number
  /** 퍼즐판 정답 자리에 고정됨 (같은 덩어리는 모두 같은 값) */
  locked: boolean
  /** 지금 들고 있는 플레이어 id (같은 덩어리는 모두 같은 값) */
  heldBy: string | null
  /**
   * 덩어리 번호. 서로 이어 붙은 조각들은 같은 값을 갖고 항상 함께 움직인다.
   * 덩어리 안에서 모든 조각은 "정답 위치 + 같은 오프셋"에 있다.
   */
  group: number
}

/** 드롭 결과로 바뀐 조각의 최종 상태 */
export interface PieceUpdate {
  id: number
  x: number
  y: number
  group: number
  locked: boolean
  z: number
}

export interface PlayerInfo {
  id: string
  name: string
  color: string
  /** 이 플레이어가 만든 연결 수 (조각끼리 붙이기 + 퍼즐판에 맞추기) */
  placed: number
}

// ---------- 클라이언트 → 서버 ----------
export type ClientMessage =
  | { t: 'join'; roomId: string; name: string }
  | { t: 'cursor'; x: number; y: number }
  | { t: 'grab'; piece: number }
  | { t: 'move'; piece: number; x: number; y: number }
  | { t: 'drop'; piece: number; x: number; y: number }

// ---------- 서버 → 클라이언트 ----------
export type ServerMessage =
  | {
      t: 'welcome'
      you: string
      puzzle: PuzzleConfig
      pieces: PieceState[]
      players: PlayerInfo[]
      solved: boolean
    }
  | { t: 'player_join'; player: PlayerInfo }
  | { t: 'player_leave'; id: string }
  | { t: 'cursor'; id: string; x: number; y: number }
  | { t: 'grab'; piece: number; by: string; z: number }
  | { t: 'grab_denied'; piece: number; x: number; y: number; locked: boolean }
  | { t: 'move'; piece: number; x: number; y: number }
  | {
      t: 'drop'
      by: string
      /** 'board' = 퍼즐판 정답 자리에 붙음, 'piece' = 다른 덩어리와 붙음, null = 그냥 내려놓음 */
      snap: 'board' | 'piece' | null
      /** 이번 드롭으로 by가 얻은 연결 수 */
      gained: number
      /** 이번 드롭으로 상태가 바뀐 모든 조각 (내려놓은 덩어리 + 합쳐진 덩어리) */
      pieces: PieceUpdate[]
    }
  | { t: 'complete' }
  | { t: 'error'; message: string }

// ---------- REST ----------
export interface RoomSummary {
  id: string
  cols: number
  rows: number
  players: number
  solved: boolean
}

export interface CreateRoomResponse {
  roomId: string
}

// ---------- 공용 헬퍼 ----------
export function cellSize(p: Pick<PuzzleConfig, 'imageWidth' | 'imageHeight' | 'cols' | 'rows'>) {
  return { pw: p.imageWidth / p.cols, ph: p.imageHeight / p.rows }
}

export function snapThreshold(pw: number, ph: number) {
  return Math.max(12, Math.min(pw, ph) * SNAP_RATIO)
}

/** 목표 조각 수와 이미지 비율로, 조각이 최대한 정사각형에 가깝게 되는 행/열 수를 구한다. */
export function computeGrid(targetPieces: number, imgW: number, imgH: number) {
  const target = Math.max(MIN_GRID * MIN_GRID, Math.min(MAX_PIECES, targetPieces))
  let cols = Math.round(Math.sqrt((target * imgW) / imgH))
  cols = Math.max(MIN_GRID, Math.min(MAX_GRID, cols))
  let rows = Math.round(target / cols)
  rows = Math.max(MIN_GRID, Math.min(MAX_GRID, rows))
  while (cols * rows > MAX_PIECES) {
    if (cols >= rows) cols--
    else rows--
  }
  return { cols, rows }
}
