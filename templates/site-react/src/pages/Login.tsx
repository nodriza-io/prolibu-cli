import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../store/auth'

export default function Login() {
  const { apiKey, login } = useAuth()
  const navigate = useNavigate()

  const [domain, setDomain] = useState(
    localStorage.getItem('prolibu_domain') ?? '',
  )
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // If already logged in redirect to home
  useEffect(() => {
    if (apiKey) navigate('/', { replace: true })
  }, [apiKey, navigate])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(domain, email, password)
      navigate('/', { replace: true })
    } catch {
      setError('Invalid credentials')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.wrapper}>
      <form onSubmit={handleSubmit} style={styles.card}>
        <h1 style={styles.title}>Prolibu Login</h1>

        {error && <p style={styles.error}>{error}</p>}

        <label style={styles.label}>
          Domain
          <input
            style={styles.input}
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="company.prolibu.com"
            required
          />
        </label>

        <label style={styles.label}>
          Email
          <input
            style={styles.input}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <label style={styles.label}>
          Password
          <input
            style={styles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        <button type="submit" disabled={loading} style={styles.btn}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    background: 'var(--surface)',
    borderRadius: 'var(--radius)',
    padding: 24,
    boxShadow: '0 1px 3px rgba(0,0,0,.1)',
  },
  title: { fontSize: 20, fontWeight: 600, textAlign: 'center' as const },
  label: { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: 14, color: 'var(--text-secondary)' },
  input: {
    padding: '10px 12px',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    fontSize: 16,
    outline: 'none',
  },
  btn: {
    padding: '10px 0',
    background: 'var(--primary)',
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--radius)',
    fontSize: 16,
    fontWeight: 500,
  },
  error: { color: '#dc2626', fontSize: 14, textAlign: 'center' as const },
}
