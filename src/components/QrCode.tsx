import { useEffect, useRef } from 'react'
import { encode } from 'uqr'

/** text를 QR코드로 그린다. 휴대폰 카메라가 바로 읽을 수 있게 흰 바탕에 검은 점, 가장자리 여백을 둔다. */
export default function QrCode({ text, size = 200 }: { text: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const qr = encode(text, { ecc: 'M', border: 2 })
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const cell = Math.max(1, Math.floor((size * dpr) / qr.size)) // 점 하나를 정수 픽셀로 그려야 경계가 번지지 않는다.
    canvas.width = cell * qr.size
    canvas.height = cell * qr.size
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#000'
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) ctx.fillRect(x * cell, y * cell, cell, cell)
      }),
    )
  }, [text, size])

  return (
    <canvas
      ref={ref}
      className="qr-code"
      style={{ width: size, height: size }}
      role="img"
      aria-label="이 방으로 들어오는 링크의 QR코드"
    />
  )
}
