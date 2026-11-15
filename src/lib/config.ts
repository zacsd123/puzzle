/** 분리 배포(프론트/백엔드 다른 도메인)용 백엔드 주소. 비어 있으면 지금처럼 같은 origin을 쓴다. */
const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`
}

export function wsUrl(path: string): string {
  if (API_BASE) return `${API_BASE.replace(/^http/, 'ws')}${path}`
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${path}`
}
