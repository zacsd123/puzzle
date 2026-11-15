const MAX_SIDE = 1600
const MIN_SIDE = 200

export interface ResizedImage {
  blob: Blob
  width: number
  height: number
}

/** 이미지 파일을 읽어 크기만 확인한다. 열 수 없는 형식이면 예외를 던진다. */
export async function readImageSize(file: Blob): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(file)
  const size = { width: bmp.width, height: bmp.height }
  bmp.close()
  return size
}

/** 긴 변을 1600px 이하로 줄이고 JPEG로 변환한다. (업로드 용량 절약, 모든 접속자가 같은 이미지를 받음) */
export async function resizeImage(file: Blob): Promise<ResizedImage> {
  const bmp = await createImageBitmap(file)
  try {
    if (Math.min(bmp.width, bmp.height) < MIN_SIDE) {
      throw new Error(`이미지가 너무 작아요. (짧은 변 ${MIN_SIDE}px 이상)`)
    }
    const ratio = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
    const width = Math.round(bmp.width * ratio)
    const height = Math.round(bmp.height * ratio)

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
