import { create } from 'zustand'
import { api } from '../api/client'

interface AuthState {
  apiKey: string
  domain: string
  me: Record<string, unknown> | null

  /** Hydrate from config / localStorage on boot */
  hydrate: () => void

  /** Email + password login (local dev) */
  login: (domain: string, email: string, password: string) => Promise<void>

  /** Clear session */
  logout: () => void
}

export const useAuth = create<AuthState>((set) => ({
  apiKey: '',
  domain: '',
  me: null,

  hydrate: () => {
    const domain = api.getDomain()
    const apiKey = api.getApiKey()
    if (domain && apiKey) {
      set({ domain, apiKey })
      // Optionally fetch /me
      api.get<Record<string, unknown>>('/me').then((me) => set({ me })).catch(() => {})
    }
  },

  login: async (domain, email, password) => {
    const data = await api.login(domain, email, password)
    localStorage.setItem('prolibu_domain', domain)
    localStorage.setItem('prolibu_apiKey', data.apiKey)
    set({ domain, apiKey: data.apiKey })
  },

  logout: () => {
    localStorage.removeItem('prolibu_domain')
    localStorage.removeItem('prolibu_apiKey')
    set({ apiKey: '', domain: '', me: null })
  },
}))
