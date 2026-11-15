import { useCallback, useSyncExternalStore } from 'react'

/** CSS 미디어 쿼리가 지금 맞는지 알려 주고, 바뀌면(창 크기, 가로/세로 전환, 키보드·트랙패드 연결 등) 다시 그리게 한다. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}

/** 휴대폰처럼 작은 화면: 세로로 든 폭 640px 이하, 또는 가로로 든 높이 520px 이하 */
export const COMPACT_QUERY = '(max-width: 640px), (max-height: 520px)'
/** 손가락이 주된 입력 장치 (폭이 넓은 아이패드도 해당) */
export const COARSE_QUERY = '(pointer: coarse)'
/** 마우스·트랙패드처럼 올려 둘 수 있는 입력 장치가 하나라도 연결되어 있음 */
export const ANY_HOVER_QUERY = '(any-hover: hover)'
