import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MAX_NAME_LENGTH, ROOM_CODE_LENGTH } from '../../shared/protocol'
import { apiUrl } from '../lib/config'
import { loadName, saveName } from '../lib/storage'

/** "ABCDE" 뿐 아니라 공유받은 링크 전체를 붙여넣어도 코드를 뽑아낸다. */
function extractCode(input: string): string {
  const upper = input.toUpperCase()
  const matches = upper.match(new RegExp(`[A-Z0-9]{${ROOM_CODE_LENGTH}}(?![A-Z0-9])`, 'g'))
  return matches ? matches[matches.length - 1] : upper.replace(/[^A-Z0-9]/g, '')
}

export default function Join() {
  const navigate = useNavigate()
  const [name, setName] = useState(loadName)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    const roomId = extractCode(code)
    if (!trimmed) return setError('이름을 입력해 주세요.')
    if (roomId.length !== ROOM_CODE_LENGTH) return setError(`방 코드는 ${ROOM_CODE_LENGTH}자리예요.`)

    setBusy(true)
    setError('')
    try {
      const res = await fetch(apiUrl(`/api/rooms/${roomId}`))
      if (res.status === 404) throw new Error('그 코드의 방을 찾을 수 없어요.')
      if (!res.ok) throw new Error('방 정보를 불러오지 못했어요.')
      saveName(trimmed)
      navigate(`/room/${roomId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '방 정보를 불러오지 못했어요.')
      setBusy(false)
    }
  }

  return (
    <main className="page page-center">
      <form className="card form-card" onSubmit={onSubmit}>
        <Link to="/" className="back-link">
          ← 처음으로
        </Link>
        <h2>방 참여하기</h2>

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

        <label className="field">
          <span>방 코드</span>
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ABCDE"
            autoFocus={!!name}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
          />
          <small className="muted">공유받은 링크를 그대로 붙여넣어도 돼요.</small>
        </label>

        {error && <p className="error-text">{error}</p>}

        <button className="btn primary big" disabled={busy}>
          {busy ? '확인 중…' : '입장하기'}
        </button>
      </form>
    </main>
  )
}
