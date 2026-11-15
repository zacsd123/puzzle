import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { MAX_CHAT_LENGTH } from '../../shared/protocol'
import { chatOpacity, normalizeChat } from '../game/chat'
import type { GameClient } from '../game/GameClient'

const PLACEHOLDER = '메시지 입력…'

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/**
 * 피그마 커서 채팅처럼 "/"를 누르면 내 마우스 커서 옆에 입력창이 뜬다.
 * - 치는 글은 바로 다른 사람 화면의 내 커서 옆에도 보인다. (최대 MAX_CHAT_LENGTH자)
 * - 마지막으로 글을 고친 뒤 3초는 또렷하게, 이어서 5초 동안 서서히 사라진다. (사라지면 입력창도 닫힘)
 * - Enter: 지금까지 쓴 글을 지우고(다른 사람 화면에서도 사라짐) 입력창은 열어 둔다. Esc: 닫기.
 * - 입력창 밖을 클릭해도 글은 그 자리에서 그대로 사라질 때까지 남는다.
 */
export default function CursorChat({
  client,
  enabled,
  color,
}: {
  client: GameClient
  enabled: boolean
  color: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [focusTick, setFocusTick] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const textRef = useRef('')
  textRef.current = text
  const pointer = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  const editedAt = useRef(0)

  const close = useCallback(() => {
    if (textRef.current) client.sendChat('')
    textRef.current = ''
    setText('')
    setOpen(false)
  }, [client])

  // 마우스 위치는 열려 있지 않을 때도 계속 기억해 둔다. ("/"를 누른 자리에서 바로 열기 위해)
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerdown', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onMove)
    }
  }, [])

  // "/" 로 열기
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
      const isSlash = e.key === '/' || (e.code === 'Slash' && !e.shiftKey)
      if (!isSlash || isTypingTarget(e.target)) return
      e.preventDefault() // 브라우저의 빠른 검색(Firefox) 등이 뜨지 않게
      editedAt.current = performance.now() // 흐려지던 글이 있으면 다시 또렷하게
      setOpen(true)
      setFocusTick((n) => n + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])

  // 연결이 끊기는 등 채팅을 쓸 수 없게 되면 닫는다.
  useEffect(() => {
    if (!enabled && open) close()
  }, [enabled, open, close])

  // 열릴 때(또는 "/"를 다시 눌렀을 때) 입력창에 포커스
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open, focusTick])

  // 열려 있는 동안 매 프레임: 마우스를 따라다니고, 글이 있으면 시간에 따라 흐려지다가 닫는다.
  useEffect(() => {
    if (!open) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const el = rootRef.current
      if (!el) return
      const { x, y } = pointer.current
      const left = Math.max(8, Math.min(x + 14, window.innerWidth - el.offsetWidth - 8))
      const top = Math.max(8, Math.min(y + 20, window.innerHeight - el.offsetHeight - 8))
      el.style.transform = `translate(${left}px, ${top}px)`
      if (textRef.current) {
        const opacity = chatOpacity(performance.now() - editedAt.current)
        el.style.opacity = String(opacity)
        if (opacity <= 0) close()
      } else {
        el.style.opacity = '1'
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open, close])

  // 화면을 떠날 때 남아 있는 글은 다른 사람 화면에서도 지운다.
  useEffect(() => {
    return () => {
      if (textRef.current) client.sendChat('')
    }
  }, [client])

  if (!open) return null

  return (
    <div ref={rootRef} className="cursor-chat" style={{ '--chat-color': color ?? 'var(--accent)' } as CSSProperties}>
      <label className="cursor-chat-pill" data-value={text || PLACEHOLDER}>
        <input
          ref={inputRef}
          className="cursor-chat-input"
          type="text"
          value={text}
          maxLength={MAX_CHAT_LENGTH}
          placeholder={PLACEHOLDER}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="커서 채팅"
          onChange={(e) => {
            const next = normalizeChat(e.target.value)
            editedAt.current = performance.now()
            textRef.current = next
            setText(next)
            client.sendChat(next)
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return // 한글 조합 중의 Enter/Esc는 조합을 마치는 용도
            if (e.key === 'Enter') {
              e.preventDefault()
              if (textRef.current) {
                textRef.current = ''
                setText('')
                client.sendChat('')
              }
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close()
            }
          }}
          onBlur={() => {
            if (!textRef.current) close() // 글이 남아 있으면 사라질 때까지 그대로 둔다.
          }}
        />
      </label>
    </div>
  )
}
