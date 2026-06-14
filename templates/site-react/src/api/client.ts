/**
 * Prolibu API client for React sites.
 *
 * Reads connection details from the injected `_prolibu_config.js` global
 * (populated at deploy-time by the Prolibu CLI), or falls back to
 * localStorage values set by a manual login flow during local development.
 */

const cfg = window.__PROLIBU_CONFIG__

function getDomain(): string {
  return cfg?.domain ?? localStorage.getItem('prolibu_domain') ?? ''
}

function getApiKey(): string {
  return cfg?.apiKey ?? localStorage.getItem('prolibu_apiKey') ?? ''
}

function baseUrl(): string {
  const d = getDomain()
  if (!d) throw new Error('Prolibu domain not configured')
  return `https://${d}/v2`
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown
  params?: Record<string, string | number | boolean | undefined>
}

async function request<T = unknown>(
  path: string,
  { body, params, headers: extraHeaders, ...rest }: RequestOptions = {},
): Promise<T> {
  const url = new URL(`${baseUrl()}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${getApiKey()}`,
    'Content-Type': 'application/json',
    ...(extraHeaders as Record<string, string>),
  }

  const res = await fetch(url.toString(), {
    ...rest,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  if (res.status === 401) {
    localStorage.removeItem('prolibu_apiKey')
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`API ${res.status}: ${text}`)
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return res.json() as Promise<T>
  return (await res.text()) as unknown as T
}

/** Convenience wrappers */
export const api = {
  get: <T = unknown>(path: string, params?: RequestOptions['params']) =>
    request<T>(path, { method: 'GET', params }),

  post: <T = unknown>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body }),

  put: <T = unknown>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body }),

  patch: <T = unknown>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body }),

  delete: <T = unknown>(path: string) =>
    request<T>(path, { method: 'DELETE' }),

  /** Login and return apiKey */
  login: async (domain: string, email: string, password: string) => {
    const res = await fetch(`https://${domain}/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) throw new Error('Login failed')
    const data = await res.json()
    return data as { apiKey: string; [key: string]: unknown }
  },

  getDomain,
  getApiKey,
}
