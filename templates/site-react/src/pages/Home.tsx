import { useEffect } from 'react'
import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { useAuth } from '../store/auth'

function Dashboard() {
  return (
    <div style={{ padding: 16 }}>
      <h2>Dashboard</h2>
      <p style={{ color: 'var(--text-secondary)', marginTop: 8 }}>
        Welcome to your Prolibu site. Edit <code>src/pages/Home.tsx</code> to
        get started.
      </p>
    </div>
  )
}

export default function Home() {
  const { logout, hydrate, me } = useAuth()
  const location = useLocation()

  useEffect(() => {
    hydrate()
  }, [hydrate])

  return (
    <>
      {/* ── Header ── */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <strong>
          {(me as Record<string, unknown>)?.name
            ? String((me as Record<string, unknown>).name)
            : 'Prolibu Site'}
        </strong>
        <button
          onClick={logout}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--primary)',
            fontSize: 14,
          }}
        >
          Logout
        </button>
      </header>

      {/* ── Content ── */}
      <main style={{ flex: 1, overflow: 'auto' }}>
        <Routes>
          <Route index element={<Dashboard />} />
          {/* Add more routes here */}
        </Routes>
      </main>

      {/* ── Bottom Nav (mobile) ── */}
      <nav
        style={{
          display: 'flex',
          borderTop: '1px solid var(--border)',
          background: 'var(--surface)',
        }}
      >
        {[{ to: '/', label: 'Home' }].map(({ to, label }) => (
          <Link
            key={to}
            to={to}
            style={{
              flex: 1,
              textAlign: 'center',
              padding: '10px 0',
              fontSize: 13,
              color:
                location.pathname === to
                  ? 'var(--primary)'
                  : 'var(--text-secondary)',
              fontWeight: location.pathname === to ? 600 : 400,
              textDecoration: 'none',
            }}
          >
            {label}
          </Link>
        ))}
      </nav>
    </>
  )
}
