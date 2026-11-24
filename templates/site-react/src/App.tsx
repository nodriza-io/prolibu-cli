import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'

// No login route: the platform's sign-in page handles that (see src/session.ts).
export default function App() {
  return (
    <Routes>
      <Route path="/*" element={<Home />} />
    </Routes>
  )
}
