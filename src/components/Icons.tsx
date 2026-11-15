/** 화면 곳곳에서 쓰는 선 모양 아이콘. 글자색(currentColor)을 따라가고, 크기는 size로 정한다. */
const PATHS = {
  back: 'M15 5l-7 7 7 7',
  share: 'M12 15V3M8 7l4-4 4 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7',
  users: 'M9 11a3.2 3.2 0 100-6.4A3.2 3.2 0 009 11zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.2a3.2 3.2 0 010 5.8M18 14.4c2 .8 3.4 2.8 3.4 5.6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9.5h.01',
  chat: 'M4 5h16v11H10l-4 4v-4H4z',
  refresh: 'M20 12a8 8 0 11-2.4-5.7M20 4v5h-5',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  close: 'M6 6l12 12M18 6L6 18',
  copy: 'M9 9h11v11H9zM5 15V4h11',
} as const

export type IconName = keyof typeof PATHS

export default function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
