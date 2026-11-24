// The site is served on the account's own domain, the same origin as the app, so it uses the
// app's session: public/prolibu-session.js reads localStorage.apiKey and calls /v2 with it.
// Without a session, or on a 401, it sends the visitor to the platform's sign-in page
// (/v2/auth/signin: password, SSO, MFA) and back here. Never build a password form and never
// remove localStorage.apiKey: it is the app's session too.

export interface SessionError extends Error {
  /** The browser is already on its way to the sign-in page. */
  signingIn?: boolean
  /** Opened outside the platform (a local dev server): there is no session here. */
  noSession?: boolean
  status?: number
}

export interface Me {
  _id?: string
  profile?: { firstName?: string; lastName?: string; email?: string }
}

export const session = {
  api: <T = unknown>(path: string, init?: Omit<RequestInit, 'body'> & { body?: unknown }) =>
    window.ProlibuSession.api<T>(path, init),
  me: () => window.ProlibuSession.me<Me>(),
  signIn: () => window.ProlibuSession.signIn(),

  /** Ends the platform session (the app's too, since the site shares it) and goes to sign-in. */
  async signOut() {
    try {
      await window.ProlibuSession.api('/auth/signout', { method: 'DELETE' })
    } catch (err) {
      if ((err as SessionError).signingIn) return
    }
    window.ProlibuSession.signIn()
  },
}

/** Text to show for a failed call, or null when the page is already going to sign in. */
export function errorText(err: unknown): string | null {
  const e = err as SessionError
  if (e?.signingIn) return null
  if (e?.noSession) return 'No Prolibu session here. Publish the site and open it at https://<domain>/site/<siteCode>/.'
  return `Could not load: ${e?.message || 'unknown error'}`
}

export function displayName(me: Me | null): string {
  const p = me?.profile ?? {}
  return [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || 'unknown'
}
