export type User = { id: string; display_name: string; email: string | null }
export type Session = { user: User; csrf_token: string; expires_at: string }
export class AuthError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}

export async function authRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api/auth/' + path, {
    ...options, credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(60000),
    headers: { Accept: 'application/json', ...options.headers },
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new AuthError(response.status, data?.error?.code ?? 'REQUEST_FAILED')
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}

export const authAPI = {
  me: () => authRequest<Session>('me'),
  config: () => authRequest<{ google_enabled: boolean }>('config'),
  start: () => authRequest<{ authorization_url: string }>('google/start', { method: 'POST' }),
  logout: (csrf: string) => authRequest<void>('logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } }),
}
