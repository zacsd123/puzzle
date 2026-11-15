import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MAX_NAME_LENGTH, MAX_PIECES, computeGrid } from '../../shared/protocol'
import type { CreateRoomResponse } from '../../shared/protocol'
import { apiUrl } from '../lib/config'
import { maxSideFor, readImageSize, resizeImage, scaledSize } from '../lib/image'
import { loadName, saveName } from '../lib/storage'

/**
 * 슬라이더가 고를 수 있는 조각 수. 애매한 숫자가 나오지 않도록 정해 둔 값만 쓴다.
 * 10 ~ 100은 10개 단위, 150 ~ 1000은 50개 단위.
 */
const PIECE_STOPS: number[] = [
  ...Array.from({ length: 10 }, (_, i) => (i + 1) * 10),
  ...Array.from({ length: 18 }, (_, i) => 150 + i * 50),
].filter((n) => n <= MAX_PIECES)

const DEFAULT_COUNT = 80
/** 조각 한 변이 이보다 작으면 조작하기 힘들다. */
const MIN_COMFORTABLE_PIECE_PX = 30

function difficultyLabel(count: number): string {
  if (count <= 30) return '쉬움'
  if (count <= 60) return '보통'
  if (count <= 100) return '도전'
  if (count <= 250) return '어려움'
  if (count <= 500) return '지옥'
  return '극악'
}

interface Picked {
  url: string
  width: number
  height: number
  file: File
}

export default function Create() {
  const navigate = useNavigate()
  const [name, setName] = useState(loadName)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [stop, setStop] = useState(() => Math.max(0, PIECE_STOPS.indexOf(DEFAULT_COUNT)))
  const count = PIECE_STOPS[stop]
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  // 미리보기용 object URL 정리
  useEffect(() => {
    return () => {
      if (picked) URL.revokeObjectURL(picked.url)
    }
  }, [picked])

  // 사진 비율에 맞춰 실제로 나뉘는 칸 수, 그리고 조각 하나의 대략적인 크기(px)
  const plan = useMemo(() => {
    if (!picked) return null
    const { width, height } = scaledSize(picked.width, picked.height, maxSideFor(count))
    const { cols, rows } = computeGrid(count, width, height)
    return { cols, rows, total: cols * rows, piecePx: Math.round(Math.min(width / cols, height / rows)) }
  }, [picked, count])

  async function pickFile(file: File | undefined) {
    if (!file) return
    setError('')
    if (!file.type.startsWith('image/')) {
      setError('이미지 파일을 선택해 주세요.')
      return
    }
    if (file.size > 30 * 1024 * 1024) {
      setError('파일이 너무 커요. (최대 30MB)')
      return
    }
    try {
      const { width, height } = await readImageSize(file)
      setPicked({ url: URL.createObjectURL(file), width, height, file })
    } catch {
      setError('이 이미지는 열 수 없어요. JPG, PNG, WEBP 파일을 사용해 주세요.')
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragOver(false)
    void pickFile(e.dataTransfer.files[0])
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return setError('이름을 입력해 주세요.')
    if (!picked) return setError('퍼즐로 만들 사진을 선택해 주세요.')

    setBusy(true)
    setError('')
    try {
      const { blob, width, height } = await resizeImage(picked.file, maxSideFor(count))
      const { cols, rows } = computeGrid(count, width, height)
      const res = await fetch(apiUrl(`/api/rooms?cols=${cols}&rows=${rows}&w=${width}&h=${height}`), {
        method: 'POST',
        headers: { 'Content-Type': blob.type },
        body: blob,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? '방을 만들지 못했어요.')
      }
      const { roomId } = (await res.json()) as CreateRoomResponse
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

        <div className="field">
          <span>퍼즐 사진</span>
          <div
            className={`dropzone${dragOver ? ' drag-over' : ''}${picked ? ' has-image' : ''}`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                fileInput.current?.click()
              }
            }}
          >
            {picked ? (
              <img src={picked.url} alt="선택한 사진 미리보기" />
            ) : (
              <div className="dropzone-hint">
                <strong>사진을 끌어다 놓거나 클릭해서 선택</strong>
                <small>JPG · PNG · WEBP</small>
              </div>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                void pickFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </div>
          {picked && (
            <button type="button" className="link-btn" onClick={() => fileInput.current?.click()}>
              다른 사진 고르기
            </button>
          )}
        </div>

        <div className="field">
          <span>난이도 (조각 수)</span>
          <div className="count-readout">
            <strong>약 {count.toLocaleString()}조각</strong>
            <em>{difficultyLabel(count)}</em>
          </div>
          <input
            type="range"
            className="slider"
            min={0}
            max={PIECE_STOPS.length - 1}
            step={1}
            value={stop}
            onChange={(e) => setStop(Number(e.target.value))}
            style={{ '--fill': `${(stop / (PIECE_STOPS.length - 1)) * 100}%` } as CSSProperties}
            aria-label="조각 수"
            aria-valuetext={`약 ${count}조각, ${difficultyLabel(count)}`}
          />
          <div className="slider-ends" aria-hidden>
            <span>{PIECE_STOPS[0]}</span>
            <span>{PIECE_STOPS[PIECE_STOPS.length - 1].toLocaleString()}</span>
          </div>
          <small className="muted">
            {plan
              ? `사진 비율에 맞춰 ${plan.cols} × ${plan.rows} = ${plan.total.toLocaleString()}조각으로 나눠요.`
              : '사진을 고르면 실제 조각 수가 계산돼요.'}
          </small>
          {plan && plan.piecePx < MIN_COMFORTABLE_PIECE_PX && (
            <small className="warn-text">
              사진 해상도에 비해 조각이 너무 많아서 한 조각이 약 {plan.piecePx}px로 아주 작아요. 더 큰 사진을 쓰거나
              조각 수를 줄이는 걸 추천해요.
            </small>
          )}
          {count >= 500 && (
            <small className="muted">조각이 많아서 처음 불러올 때 시간이 걸리고, 사양이 낮은 기기에서는 느릴 수 있어요.</small>
          )}
        </div>

        {error && <p className="error-text">{error}</p>}

        <button className="btn primary big" disabled={busy}>
          {busy ? '만드는 중…' : '퍼즐 시작하기'}
        </button>
      </form>
    </main>
  )
}
