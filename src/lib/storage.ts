import { CLIENT_TOKEN_PATTERN } from '../../shared/protocol'

const NAME_KEY = 'puzzle-party:name'
const CLIENT_KEY = 'puzzle-party:client-id'
const TAB_KEY = 'puzzle-party:tab-id'

export function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name)
  } catch {
    /* 저장 불가 환경이면 무시 */
  }
}

/** 보안 컨텍스트가 아닌 http://192.168.x.x 에서도 쓸 수 있도록 crypto.randomUUID 대신 getRandomValues로 만든다. */
export function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

// 저장소를 못 쓰는 환경(시크릿 모드 등)에서도 같은 페이지 안에서는 같은 값을 쓰도록 메모리에 둔다.
let memoryClientId: string | null = null
let memoryTabId: string | null = null

/**
 * 이 브라우저를 알아보는 값. 방에서 나갔다 다시 들어와도 서버가 같은 사람으로 알아보고
 * 점수 같은 기록을 이어 주는 데 쓴다. 쿠키 대신 localStorage에 저장한다.
 * (프론트와 서버 도메인이 달라서 쿠키는 서드파티로 막히기 쉽다.)
 */
export function loadClientId(): string {
  try {
    const saved = localStorage.getItem(CLIENT_KEY)
    if (saved && CLIENT_TOKEN_PATTERN.test(saved)) return saved
    const fresh = randomId()
    localStorage.setItem(CLIENT_KEY, fresh)
    return fresh
  } catch {
    return (memoryClientId ??= randomId())
  }
}

/**
 * 이 탭을 알아보는 값. 탭마다 따로이고 새로고침해도 유지된다(sessionStorage).
 * 서버는 같은 브라우저에서 같은 값으로 다시 들어오면 "같은 탭이 새로고침/재접속한 것"으로 보고 이전 연결을 대체하고,
 * 다른 값이면 "다른 탭"으로 보고 따로 참가시킨다.
 */
export function loadTabId(): string {
  try {
    const saved = sessionStorage.getItem(TAB_KEY)
    if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved
    const fresh = randomId(12)
    sessionStorage.setItem(TAB_KEY, fresh)
    return fresh
  } catch {
    return (memoryTabId ??= randomId(12))
  }
}
