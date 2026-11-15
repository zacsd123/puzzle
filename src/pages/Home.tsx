import { Link } from 'react-router-dom'

export default function Home() {
  return (
    <main className="page page-center">
      <div className="hero">
        <div className="logo" aria-hidden>
          🧩
        </div>
        <h1>퍼즐 파티</h1>
        <p className="tagline">사진 한 장을 올리면, 친구들과 함께 실시간으로 퍼즐을 맞출 수 있어요.</p>
      </div>

      <div className="choice-grid">
        <Link to="/create" className="choice-card">
          <span className="choice-icon" aria-hidden>
            ✨
          </span>
          <strong>방 만들기</strong>
          <span>사진을 올려 새 퍼즐 방을 만들어요</span>
        </Link>
        <Link to="/join" className="choice-card">
          <span className="choice-icon" aria-hidden>
            🔑
          </span>
          <strong>방 참여하기</strong>
          <span>방 코드로 친구의 퍼즐에 들어가요</span>
        </Link>
      </div>
    </main>
  )
}
