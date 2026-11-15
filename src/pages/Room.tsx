import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { MAX_NAME_LENGTH } from '../../shared/protocol'
import GameScreen from '../components/GameScreen'
import { GameClient } from '../game/GameClient'
import { loadName, saveName } from '../lib/storage'

export default function Room() {
  const roomId = (useParams().roomId ?? '').toUpperCase()
  const [name, setName] = useState(loadName)
  const [draft, setDraft] = useState('')

  // 이름이 없으면(= 공유 링크로 바로 들어온 경우) 이름만 물어본다.
  if (!name) {
    const onSubmit = (e: FormEvent) => {
      e.preventDefault()
      const trimmed = draft.trim()
      if (!trimmed) return
      saveName(trimmed)
      setName(trimmed)
    }
    return (
      <main className="page page-center">
        <form className="card form-card" onSubmit={onSubmit}>
          <h2>
            방 <span className="room-code-inline">{roomId}</span> 입장
          </h2>
          <label className="field">
            <span>내 이름</span>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={MAX_NAME_LENGTH}
              placeholder="다른 사람에게 보여질 이름"
              autoFocus
            />
          </label>
          <button className="btn primary big" disabled={!draft.trim()}>
            입장하기
          </button>
          <Link to="/" className="back-link center">
            처음으로
          </Link>
        </form>
      </main>
    )
  }

  return <RoomSession key={`${roomId}:${name}`} roomId={roomId} name={name} />
}

function RoomSession({ roomId, name }: { roomId: string; name: string }) {
  const [client, setClient] = useState<GameClient | null>(null)

  useEffect(() => {
    const c = new GameClient(roomId, name)
    setClient(c)
    return () => c.destroy()
  }, [roomId, name])

  if (!client) return null
  return <GameScreen client={client} roomId={roomId} />
}
