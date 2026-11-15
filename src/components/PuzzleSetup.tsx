import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent } from 'react'
import { MAX_PIECES, computeGrid } from '../../shared/protocol'
import { maxSideFor, readImageSize, scaledSize } from '../lib/image'
import { COARSE_QUERY, useMediaQuery } from '../lib/useMediaQuery'

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

export interface PickedImage {
  url: string
  width: number
  height: number
  file: File
}

/**
 * "사진 고르기 + 조각 수 고르기" 상태. 방 만들기 화면과 "새 사진으로 다시 하기" 창이 같이 쓴다.
 * 화면에는 PuzzleSetupFields로 그린다.
 */
export function usePuzzleSetup() {
  const [picked, setPicked] = useState<PickedImage | null>(null)
  const [stop, setStop] = useState(() => Math.max(0, PIECE_STOPS.indexOf(DEFAULT_COUNT)))
  const count = PIECE_STOPS[stop]

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

  /** 파일을 고른다. 쓸 수 없는 파일이면 이유를, 괜찮으면 null을 돌려준다. */
  async function pickFile(file: File | undefined): Promise<string | null> {
    if (!file) return null
    if (!file.type.startsWith('image/')) return '이미지 파일을 선택해 주세요.'
    if (file.size > 30 * 1024 * 1024) return '파일이 너무 커요. (최대 30MB)'
    try {
      const { width, height } = await readImageSize(file)
      setPicked({ url: URL.createObjectURL(file), width, height, file })
      return null
    } catch {
      return '이 이미지는 열 수 없어요. JPG, PNG, WEBP 파일을 사용해 주세요.'
    }
  }

  return { picked, stop, setStop, count, plan, pickFile }
}

export type PuzzleSetupState = ReturnType<typeof usePuzzleSetup>

export function PuzzleSetupFields({
  setup,
  onError,
}: {
  setup: PuzzleSetupState
  /** 사진을 고르다 생긴 문제(빈 문자열이면 문제 없음)를 알린다. */
  onError: (message: string) => void
}) {
  const { picked, stop, setStop, count, plan, pickFile } = setup
  const coarse = useMediaQuery(COARSE_QUERY) // 손가락이 주 입력(휴대폰/태블릿)이면 끌어다 놓기 대신 탭 안내
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  async function choose(file: File | undefined) {
    if (!file) return
    onError((await pickFile(file)) ?? '')
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragOver(false)
    void choose(e.dataTransfer.files[0])
  }

  return (
    <>
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
              <strong>{coarse ? '탭해서 사진 고르기' : '사진을 끌어다 놓거나 클릭해서 선택'}</strong>
              <small>{coarse ? '앨범에서 고르거나 카메라로 찍어요' : 'JPG · PNG · WEBP'}</small>
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              void choose(e.target.files?.[0])
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
        {coarse && count > 300 && count < 500 && (
          <small className="muted">휴대폰·태블릿에서는 조각이 많으면 느려질 수 있어요. 300조각 이하를 추천해요.</small>
        )}
        {count >= 500 && (
          <small className="muted">조각이 많아서 처음 불러올 때 시간이 걸리고, 사양이 낮은 기기에서는 느릴 수 있어요.</small>
        )}
      </div>
    </>
  )
}
