/// <reference types="vite/client" />

// window.ProlibuSession comes from public/prolibu-session.js, loaded by index.html.
interface ProlibuSessionApi {
  token(): string | null
  signIn(): void
  api<T = unknown>(path: string, init?: Omit<RequestInit, 'body'> & { body?: unknown }): Promise<T>
  me<T = Record<string, unknown>>(): Promise<T>
}

interface Window {
  ProlibuSession: ProlibuSessionApi
}
