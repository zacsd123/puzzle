import { useState } from 'react'
import type { FormEvent } from 'react'
import { uploadPuzzle } from '../lib/upload'
import { PuzzleSetupFields, usePuzzleSetup } from './PuzzleSetup'

/**
 * 퍼즐을 완성한 뒤 방장이 새 사진과 조각 수를 골라 같은 방에서 다시 시작하는 창.
 * 요청이 성공하면 서버가 방의 모든 사람(나 포함)에게 새 퍼즐을 보낸다. 이 창은 그때 GameScreen이 닫으므로,
 * 성공한 뒤에는 새 퍼즐이 도착할 때까지 "준비 중" 상태로 둔다.
 */
export default function RestartDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const setup = usePuzzleSetup()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!setup.picked) return setError('새로 만들 사진을 선택해 주세요.')
    setBusy(true)
    setError('')
    try {
      await uploadPuzzle(`/api/rooms/${roomId}/restart`, setup.picked.file, setup.count, '새 퍼즐을 시작하지 못했어요.')
    } catch (err) {
      setError(err instanceof Error ? err.message : '새 퍼즐을 시작하지 못했어요.')
      setBusy(false)
    }
  }

  return (
    <div className="overlay">
      <form className="card modal wide" onSubmit={onSubmit}>
        <h2>새 사진으로 다시 하기</h2>
        <p className="muted">지금 방에 있는 사람들과 새 퍼즐을 시작해요. 연결 횟수는 0부터 다시 세요.</p>

        <PuzzleSetupFields setup={setup} onError={setError} />

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? '준비 중…' : '새 퍼즐 시작'}
          </button>
        </div>
      </form>
    </div>
  )
}
