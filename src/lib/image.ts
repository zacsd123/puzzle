const MIN_SIDE = 200

export interface ResizedImage {
  blob: Blob
  width: number
  height: number
}

/**
 * 조각 수에 맞춰 사진의 긴 변 상한을 정한다.
 * 조각이 많을수록 조각 하나가 작아지므로, 많을 때는 해상도를 높여 줘야 확대했을 때 덜 흐릿하다.
 */
export function maxSideFor(pieceCount: number): number {
  return pieceCount > 300 ? 2400 : 1600
}

/** 리사이즈 후의 크기. (확대는 하지 않는다) */
export function scaledSize(width: number, height: number, maxSide: number) {
  const ratio = Math.min(1, maxSide / Math.max(width, height))
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) }
}

/** 이미지 파일을 읽어 크기만 확인한다. 열 수 없는 형식이면 예외를 던진다. */
export async function readImageSize(file: Blob): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(file)
  const size = { width: bmp.width, height: bmp.height }
  bmp.close()
  return size
}

/** 긴 변을 maxSide(px) 이하로 줄이고 JPEG로 변환한다. (업로드 용량 절약, 모든 접속자가 같은 이미지를 받음) */
export async function resizeImage(file: Blob, maxSide: number): Promise<ResizedImage> {
  const bmp = await createImageBitmap(file)
  try {
    if (Math.min(bmp.width, bmp.height) < MIN_SIDE) {
      throw new Error(`이미지가 너무 작아요. (짧은 변 ${MIN_SIDE}px 이상)`)
    }
    const { width, height } = scaledSize(bmp.width, bmp.height, maxSide)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff' // 투명 PNG 배경
    ctx.fillRect(0, 0, width, height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, width, height)

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
    if (!blob) throw new Error('이미지를 변환하지 못했어요.')
    return { blob, width, height }
  } finally {
    bmp.close()
  }
}
