import { MAX_CHAT_LENGTH } from '../../shared/protocol'

/** 마지막으로 글이 바뀐 뒤 이 시간 동안은 또렷하게 보이고, */
export const CHAT_HOLD_MS = 3000
/** 그 다음 이 시간 동안 서서히 투명해지면서 사라진다. */
export const CHAT_FADE_MS = 5000

/** 마지막으로 글이 바뀐 뒤 age(ms)가 지났을 때의 불투명도. 0이면 완전히 사라진 것. */
export function chatOpacity(age: number): number {
  if (age <= CHAT_HOLD_MS) return 1
  return Math.max(0, 1 - (age - CHAT_HOLD_MS) / CHAT_FADE_MS)
}

/** 입력값 정리: 줄바꿈/연속 공백은 한 칸으로, 앞 공백은 없애고, 최대 글자 수로 자른다. (서버와 같은 규칙) */
export function normalizeChat(raw: string): string {
  return Array.from(raw.replace(/\s+/g, ' ').replace(/^ /, ''))
    .slice(0, MAX_CHAT_LENGTH)
    .join('')
}
