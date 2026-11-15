import { useEffect } from 'react'

/**
 * active인 동안 화면이 저절로 꺼지지 않게 한다. (퍼즐은 한참 보고 있어도 터치가 거의 없어서 휴대폰/태블릿 화면이 꺼지기 쉽다.)
 * 지원하지 않는 브라우저(iOS 16.3 이하 등)에서는 아무 일도 하지 않는다. 화면이 가려졌다 돌아오면 자동으로 해제되므로 다시 잡는다.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let sentinel: WakeLockSentinel | null = null
    let cancelled = false

    const acquire = async () => {
      try {
        const s = await navigator.wakeLock.request('screen')
        if (cancelled) void s.release()
        else sentinel = s
      } catch {
        /* 배터리 절약 모드 등으로 거절될 수 있다. 없어도 퍼즐은 할 수 있다. */
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible' && (!sentinel || sentinel.released)) void acquire()
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void sentinel?.release()
    }
  }, [active])
}
