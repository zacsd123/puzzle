import { useState } from 'react'
import Icon from './Icons'
import QrCode from './QrCode'

/** https/localhost에서는 clipboard API, 같은 와이파이(http)에서는 구형 방식으로 대체. 성공하면 true. */
export function copyText(text: string): boolean {
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

export const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

export function inviteLink(roomId: string) {
  return `${location.origin}/room/${roomId}`
}

/** 휴대폰/태블릿의 공유창(카카오톡 등)으로 초대 링크를 보낸다. 취소하면 false, 공유창을 못 열면 예외. */
export async function shareInvite(roomId: string): Promise<boolean> {
  try {
    await navigator.share({
      title: '퍼즐 파티',
      text: `같이 퍼즐 맞춰요! 방 코드 ${roomId}`,
      url: inviteLink(roomId),
    })
    return true
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return false // 사용자가 공유창을 닫았다.
    throw err
  }
}

/** 친구 초대: 링크 복사, (지원하면) 공유창, 그리고 옆 사람이 휴대폰 카메라로 바로 들어올 수 있는 QR코드. */
export default function InviteDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const link = inviteLink(roomId)

  function onCopy() {
    if (copyText(link)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } else {
      window.prompt('이 링크를 복사해서 친구에게 보내 주세요', link)
    }
  }

  async function onShare() {
    try {
      await shareInvite(roomId)
    } catch {
      onCopy() // 공유창을 못 열면 복사로 대신한다.
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card modal invite-dialog" role="dialog" aria-label="친구 초대" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="icon-btn dialog-close" onClick={onClose} aria-label="닫기">
          <Icon name="close" />
        </button>
        <h2>친구 초대</h2>
        <div className="room-code big">{roomId}</div>
        <QrCode text={link} size={176} />
        <p className="muted">휴대폰 카메라로 QR코드를 비추면 바로 들어와요.</p>
        <input type="text" className="invite-link" value={link} readOnly onFocus={(e) => e.currentTarget.select()} aria-label="초대 링크" />
        <div className="modal-actions wrap">
          {canShare && (
            <button type="button" className="btn primary" onClick={() => void onShare()}>
              <Icon name="share" size={18} /> 공유하기
            </button>
          )}
          <button type="button" className={`btn${canShare ? '' : ' primary'}`} onClick={onCopy}>
            <Icon name="copy" size={18} /> {copied ? '복사됨!' : '링크 복사'}
          </button>
        </div>
      </div>
    </div>
  )
}
