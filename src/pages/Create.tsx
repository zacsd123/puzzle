import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MAX_NAME_LENGTH, computeGrid } from '../../shared/protocol'
import type { CreateRoomResponse } from '../../shared/protocol'
import { apiUrl } from '../lib/config'
import { readImageSize, resizeImage } from '../lib/image'
import { loadName, saveName } from '../lib/storage'

const PIECE_PRESETS = [
  { count: 24, label: '쉬움' },
  { count: 48, label: '보통' },
  { count: 80, label: '도전' },
  { count: 140, label: '어려움' },
  { count: 250, label: '지옥' },
]

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
  const [count, setCount] = useState(80)
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

  const grid = useMemo(
    () => (picked ? computeGrid(count, picked.width, picked.height) : null),
    [picked, count],
  )

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
      const { blob, width, height } = await resizeImage(picked.file)
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
          <span>난이도</span>
          <div className="segmented">
            {PIECE_PRESETS.map((p) => (
              <button
                key={p.count}
                type="button"
                className={count === p.count ? 'active' : ''}
                onClick={() => setCount(p.count)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <small className="muted">
            {grid
              ? `${grid.cols} × ${grid.rows} = ${grid.cols * grid.rows}조각`
              : '사진을 고르면 조각 수가 계산돼요.'}
          </small>
        </div>

        {error && <p className="error-text">{error}</p>}

        <button className="btn primary big" disabled={busy}>
          {busy ? '만드는 중…' : '퍼즐 시작하기'}
        </button>
      </form>
    </main>
  )
}
