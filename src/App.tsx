import { Navigate, Route, Routes } from 'react-router-dom'
import Home from './pages/Home'
import Create from './pages/Create'
import Join from './pages/Join'
import Room from './pages/Room'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/create" element={<Create />} />
      <Route path="/join" element={<Join />} />
      <Route path="/room/:roomId" element={<Room />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
