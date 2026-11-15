import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MAX_NAME_LENGTH } from '../../shared/protocol'
import type { CreateRoomResponse } from '../../shared/protocol'
import { PuzzleSetupFields, usePuzzleSetup } from '../components/PuzzleSetup'
import { loadName, saveName } from '../lib/storage'
import { uploadPuzzle } from '../lib/upload'

export default function Create() {
  const navigate = useNavigate()
  const [name, setName] = useState(loadName)
  const setup = usePuzzleSetup()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return setError('이름을 입력해 주세요.')
    if (!setup.picked) return setError('퍼즐로 만들 사진을 선택해 주세요.')

    setBusy(true)
    setError('')
    try {
      const { roomId } = await uploadPuzzle<CreateRoomResponse>(
        '/api/rooms',
        setup.picked.file,
        setup.count,
        '방을 만들지 못했어요.',
      )
      saveName(trimmed)
      navigate(`/room/${roomId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '방을 만들지 못했어요.')
      setBusy(false)
    }
  }

  return (
    <main className="page page-center">
      <form className="card form-card" onSubmit={onSubmit}>
        <Link to="/" className="back-link">
          ← 처음으로
        </Link>
        <h2>방 만들기</h2>

        <label className="field">
          <span>내 이름</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME_LENGTH}
            placeholder="다른 사람에게 보여질 이름"
            autoFocus={!name}
          />
        </label>

        <PuzzleSetupFields setup={setup} onError={setError} />

        {error && <p className="error-text">{error}</p>}

        <button className="btn primary big" disabled={busy}>
          {busy ? '만드는 중…' : '퍼즐 시작하기'}
        </button>
      </form>
    </main>
  )
}
