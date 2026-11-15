import { CLIENT_TOKEN_HEADER, computeGrid } from '../../shared/protocol'
import { apiUrl } from './config'
import { maxSideFor, resizeImage } from './image'
import { loadClientId } from './storage'

/**
 * 고른 사진을 줄여서 서버의 path(방 만들기, 새 퍼즐 시작)로 올린다.
 * 내 브라우저 식별값을 함께 보내서, 방을 만들 때는 방장 표시가 되고 새 퍼즐을 시작할 때는 방장인지 확인받는다.
 * 실패하면 서버가 준 메시지(없으면 failMessage)로 예외를 던진다.
 */
export async function uploadPuzzle<T>(path: string, file: File, count: number, failMessage: string): Promise<T> {
  const { blob, width, height } = await resizeImage(file, maxSideFor(count))
  const { cols, rows } = computeGrid(count, width, height)
  const res = await fetch(apiUrl(`${path}?cols=${cols}&rows=${rows}&w=${width}&h=${height}`), {
    method: 'POST',
    headers: { 'Content-Type': blob.type, [CLIENT_TOKEN_HEADER]: loadClientId() },
    body: blob,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? failMessage)
  }
  return (await res.json()) as T
}
