import { useEffect, useState } from 'react'
import { Routes, Route } from 'react-router-dom'
import { session, errorText, displayName, type Me } from '../session'

interface Deal {
  _id: string
  dealName?: string
}

function Dashboard() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // One small page of records per visit: newest first by _id (indexed), only the fields shown.
    // For totals or many rows, read a Prolibu report instead (see HEAVY-READS.md).
    const query = new URLSearchParams({ limit: '5', sort: '-_id', select: 'dealName' })
    session
      .api<{ data?: Deal[] }>(`/deal?${query}`)
      .then((res) => { if (!cancelled) setDeals(res?.data ?? []) })
      .catch((err) => { if (!cancelled) setError(errorText(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return (
    <co-card variant="outlined" padding="sm">
      <h2>Latest deals</h2>
      {loading && <co-skeleton />}
      {!loading && !error && deals.length === 0 && (
        <co-empty-state heading="No deals yet" description="Deals you can see will show up here." icon="briefcase" variant="plain" />
      )}
      {deals.map((deal) => (
        <co-list-item key={deal._id} label={deal.dealName || '(no name)'} icon="briefcase" />
      ))}
      {error && <co-helper-text status="error">{error}</co-helper-text>}
    </co-card>
  )
}

export default function Home() {
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    session.me().then(setMe).catch((err) => setError(errorText(err)))
  }, [])

  return (
    <>
      <header className="header">
        <div>
          <h1>Prolibu Site</h1>
          <p className="muted">{me ? `Signed in as ${displayName(me)}` : error ?? 'Checking your session…'}</p>
        </div>
        {me && (
          <co-button variant="stroke" shape="square" onClick={() => session.signOut()}>
            Sign out
          </co-button>
        )}
      </header>

      <main className="main">
        {me && (
          <Routes>
            <Route index element={<Dashboard />} />
            {/* Add more routes here. config.json must say "siteType": "SPA" for client routes. */}
          </Routes>
        )}
        <p className="muted">
          Edit <code>src/pages/Home.tsx</code> to build your site.
        </p>
      </main>
    </>
  )
}
