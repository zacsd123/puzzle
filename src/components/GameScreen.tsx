import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import { BoardView } from '../game/BoardView'
import type { GameClient } from '../game/GameClient'
import CursorChat from './CursorChat'

function copyText(text: string): boolean {
  // https/localhost에서는 clipboard API, 같은 와이파이(http)에서는 구형 방식으로 대체
  if (navigator.clipboard && window.isSecureContext) {
    void navigator.clipboard.writeText(text)
    return true
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}

export default function GameScreen({ client, roomId }: { client: GameClient; roomId: string }) {
  const snap = useSyncExternalStore(client.subscribe, client.getSnapshot)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<BoardView | null>(null)
  const [ghost, setGhost] = useState(false)
  const [copied, setCopied] = useState(false)
  const [resultDismissed, setResultDismissed] = useState(false)

  useEffect(() => {
    const view = new BoardView(canvasRef.current!, client)
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [client])

  useEffect(() => {
    viewRef.current?.setGhost(ghost)
  }, [ghost])

  function onCopy() {
    const ok = copyText(`${location.origin}/room/${roomId}`)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } else {
      window.prompt('이 링크를 복사해서 친구에게 보내 주세요', `${location.origin}/room/${roomId}`)
    }
  }

  const ranking = [...snap.players].sort((a, b) => b.placed - a.placed || a.name.localeCompare(b.name))
  // 진행도 = 조각이 하나의 덩어리로 이어진 정도. (덩어리 1개 = 100%)
  const pct = snap.total > 1 ? Math.round(((snap.total - snap.groups) / (snap.total - 1)) * 100) : 0
  const loading = snap.status === 'connecting' || snap.status === 'loading'

  return (
    <div className="game">
      <canvas ref={canvasRef} className="game-canvas" />

      <CursorChat
        client={client}
        enabled={snap.status === 'ready'}
        color={snap.players.find((p) => p.id === snap.meId)?.color}
      />

      {/* 왼쪽 위: 방 정보 + 진행도 */}
      <section className="hud hud-top-left">
        <div className="hud-row">
          <Link to="/" className="icon-btn" title="나가기">
            ←
          </Link>
          <div className="room-code" title="방 코드">
            {roomId}
          </div>
          <button className="btn small" onClick={onCopy}>
            {copied ? '복사됨!' : '초대 링크 복사'}
          </button>
        </div>
        <div className="progress" aria-label={`진행도 ${pct}%`}>
          <div className="progress-bar" style={{ width: `${pct}%` }} />
        </div>
        <div className="progress-text">
          {pct}% · 남은 덩어리 {snap.groups}개
        </div>
      </section>

      {/* 오른쪽 위: 참가자 */}
      <section className="hud hud-top-right">
        <h3>
          <span>참가자 {snap.players.length}명</span>
          <span title="조각을 붙인 횟수">연결</span>
        </h3>
        <ul className="player-list">
          {ranking.map((p) => (
            <li key={p.id}>
              <span className="dot" style={{ background: p.color }} />
              <span className="player-name">
                {p.name}
                {p.id === snap.meId && <em className="me-badge">나</em>}
              </span>
              <span className="player-score">{p.placed}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* 아래: 도구 */}
      <section className="hud hud-bottom">
        <button className="btn small" onClick={() => viewRef.current?.fit()}>
          전체 보기
        </button>
        <button className="btn small" onClick={() => viewRef.current?.zoomBy(1 / 1.25)} aria-label="축소">
          −
        </button>
        <button className="btn small" onClick={() => viewRef.current?.zoomBy(1.25)} aria-label="확대">
          +
        </button>
        <button className={`btn small${ghost ? ' active' : ''}`} onClick={() => setGhost((g) => !g)}>
          원본 힌트 {ghost ? '끄기' : '보기'}
        </button>
        <span className="hint">
          맞는 조각끼리 가까이 두면 붙어요 · 빈 곳 드래그로 이동 · 휠로 확대/축소 · <kbd>/</kbd> 키로 채팅
        </span>
      </section>

      {snap.status === 'reconnecting' && (
        <div className="banner">연결이 끊겼어요. 다시 연결하는 중…</div>
      )}

      {loading && (
        <div className="overlay">
          <div className="spinner" />
          <p>퍼즐을 불러오는 중…</p>
        </div>
      )}

      {snap.status === 'closed' && (
        <div className="overlay">
          <div className="card modal">
            <h2>입장할 수 없어요</h2>
            <p className="muted">{snap.error ?? '연결이 끊어졌어요.'}</p>
            <div className="modal-actions">
              <Link to="/" className="btn primary">
                처음으로
              </Link>
              <button className="btn" onClick={() => location.reload()}>
                다시 시도
              </button>
            </div>
          </div>
        </div>
      )}

      {snap.solved && !resultDismissed && snap.status === 'ready' && (
        <div className="overlay">
          <div className="card modal">
            <div className="trophy" aria-hidden>
              🎉
            </div>
            <h2>퍼즐 완성!</h2>
            <ol className="ranking">
              {ranking.map((p, i) => (
                <li key={p.id}>
                  <span className="rank">{i + 1}</span>
                  <span className="dot" style={{ background: p.color }} />
                  <span className="player-name">{p.name}</span>
                  <span className="player-score">{p.placed}회 연결</span>
                </li>
              ))}
            </ol>
            <div className="modal-actions">
              <button className="btn primary" onClick={() => setResultDismissed(true)}>
                완성본 보기
              </button>
              <Link to="/" className="btn">
                처음으로
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
