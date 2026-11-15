// 클라이언트와 서버가 공유하는 타입/상수.
// 좌표는 모두 "월드 좌표"(= 원본 이미지 픽셀 단위)이고, 퍼즐판(보드)의 왼쪽 위가 (0, 0)이다.
// 각 플레이어의 줌/스크롤은 로컬 화면에서만 적용되므로, 월드 좌표로 주고받으면
// 화면 크기가 달라도 커서/조각 위치가 정확히 일치한다.

export const MAX_NAME_LENGTH = 16
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MIN_GRID = 2
export const MAX_GRID = 60 // 가로로 아주 긴 사진도 1000조각까지 나눌 수 있도록 넉넉하게
export const MAX_PIECES = 1000
/** 브라우저/탭 식별값이 따라야 하는 형식 (서버·화면 공용) */
export const CLIENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
/** 방을 만들거나 새 퍼즐을 시작할 때 "나는 방장이다"를 밝히는 요청 헤더 */
export const CLIENT_TOKEN_HEADER = 'X-Client-Token'
/** 커서 채팅 한 번에 쓸 수 있는 최대 글자 수 */
export const MAX_CHAT_LENGTH = 30
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
  /** 새 퍼즐로 바뀔 때마다 주소 끝의 ?v= 값이 달라져서 브라우저가 이전 사진을 재사용하지 않는다. */
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
  /** 이 플레이어가 조각을 붙인 횟수 (조각끼리 붙이기 / 퍼즐판에 맞추기, 한 번 내려놓아 붙으면 1) */
  placed: number
}

// ---------- 클라이언트 → 서버 ----------
export type ClientMessage =
  | {
      t: 'join'
      roomId: string
      name: string
      /** 이 브라우저를 알아보는 값. 나갔다 다시 들어와도 같은 사람으로 보고 기록을 이어 준다. */
      token?: string
      /** 이 화면(탭) 하나를 알아보는 값. 같은 탭이 재접속하는 것과 다른 탭을 구분한다. */
      session?: string
    }
  | { t: 'cursor'; x: number; y: number }
  /** 커서 옆에 띄울 글. 입력 중인 글 전체를 보내고, 빈 문자열이면 지운다. */
  | { t: 'chat'; text: string }
  /** 연결이 살아 있는지 확인한다. (휴대폰이 백그라운드에서 돌아왔을 때 등) 서버는 'pong'으로 답한다. */
  | { t: 'ping' }
  | { t: 'grab'; piece: number }
  | { t: 'move'; piece: number; x: number; y: number }
  | { t: 'drop'; piece: number; x: number; y: number }

// ---------- 서버 → 클라이언트 ----------
export type ServerMessage =
  | {
      /** 입장했을 때, 그리고 방장이 새 퍼즐을 시작했을 때(모두에게 새로) 온다. */
      t: 'welcome'
      you: string
      puzzle: PuzzleConfig
      pieces: PieceState[]
      players: PlayerInfo[]
      solved: boolean
      /** 방장 플레이어 id */
      host: string | null
    }
  /** 방장이 바뀌었다. (방장이 나가거나 다시 들어온 경우) */
  | { t: 'host'; id: string | null }
  | { t: 'pong' }
  | { t: 'player_join'; player: PlayerInfo }
  | { t: 'player_leave'; id: string }
  | { t: 'cursor'; id: string; x: number; y: number }
  | { t: 'chat'; id: string; text: string }
  | { t: 'grab'; piece: number; by: string; z: number }
  | { t: 'grab_denied'; piece: number; x: number; y: number; locked: boolean }
  | { t: 'move'; piece: number; x: number; y: number }
  | {
      t: 'drop'
      by: string
      /** 'board' = 퍼즐판 정답 자리에 붙음, 'piece' = 다른 덩어리와 붙음, null = 그냥 내려놓음 */
      snap: 'board' | 'piece' | null
      /** 이번 드롭으로 by가 얻은 연결 수. 붙었으면 1, 아니면 0 (한 번에 여러 개가 붙어도 1) */
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

/** 조각의 가로:세로 비율이 이 범위(1/1.25 ~ 1.25)를 벗어나면 너무 납작/길쭉하다고 본다. */
const MAX_PIECE_SKEW = Math.log(1.25)

/**
 * 목표 조각 수와 이미지 비율로 열/행 수를 구한다.
 * 조각이 너무 길쭉해지지 않는 범위에서 목표 개수에 가장 가까운 분할을 고르므로,
 * 슬라이더에서 80개를 골랐다면 대부분 정확히 80개로 나뉜다. (사진 비율에 따라 몇 개 차이 날 수 있음)
 */
export function computeGrid(targetPieces: number, imgW: number, imgH: number) {
  const target = Math.max(MIN_GRID * MIN_GRID, Math.min(MAX_PIECES, Math.round(targetPieces)))

  let best: { cols: number; rows: number; miss: number; skew: number } | null = null
  for (let cols = MIN_GRID; cols <= MAX_GRID; cols++) {
    const base = Math.floor(target / cols)
    for (const rows of [base, base + 1]) {
      if (rows < MIN_GRID || rows > MAX_GRID || cols * rows > MAX_PIECES) continue
      const skew = Math.abs(Math.log(imgW / cols / (imgH / rows)))
      if (skew > MAX_PIECE_SKEW) continue
      const miss = Math.abs(cols * rows - target)
      if (!best || miss < best.miss || (miss === best.miss && skew < best.skew)) {
        best = { cols, rows, miss, skew }
      }
    }
  }
  if (best) return { cols: best.cols, rows: best.rows }

  // 아주 길쭉한 사진 등으로 조건에 맞는 분할이 없으면, 조각이 가장 정사각형에 가까운 분할을 쓴다.
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
