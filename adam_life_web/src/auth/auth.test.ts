import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthController } from './controller'
import { AuthError, authRequest, type Session } from './client'

const user = (id = 'alice'): Session => ({ user: { id, display_name: id, email: id + '@example.test' }, csrf_token: 'csrf-' + id, expires_at: '2099-01-01T00:00:00Z' })
const api = () => ({
  me: vi.fn(async () => user()), config: vi.fn(async () => ({ google_enabled: true })),
  start: vi.fn(async () => ({ authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=test' })),
  logout: vi.fn(async (_csrf: string) => undefined),
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
afterEach(() => vi.unstubAllGlobals())

describe('server sessions and memory isolation', () => {
  it('keeps the workspace mounted during background session validation', async () => {
    const server = api(), auth = new AuthController(server), pending = deferred<Session>()
    await auth.restore()
    server.me.mockReturnValueOnce(pending.promise)
    const checking = auth.restore()
    expect(auth.snapshot()).toEqual({ kind: 'authenticated', session: user() })
    pending.resolve(user()); await checking
    expect(auth.snapshot().kind).toBe('authenticated')
  })
  it('restores a server session without browser storage', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('must not read storage') }, setItem: () => { throw new Error('must not write storage') } })
    const auth = new AuthController(api())
    await auth.restore()
    expect(auth.snapshot()).toEqual({ kind: 'authenticated', session: user() })
  })
  it('401 never activates the demonstration automatically', async () => {
    const server = api(); server.me.mockRejectedValue(new AuthError(401, 'SESSION_EXPIRED'))
    const auth = new AuthController(server)
    await auth.restore()
    expect(auth.snapshot()).toEqual({ kind: 'anonymous', enabled: true })
    auth.demo()
    expect(auth.snapshot()).toEqual({ kind: 'demo' })
  })
  it('preserves an unexpired session and editor through a temporary network failure', async () => {
    const server = api(), auth = new AuthController(server)
    await auth.restore()
    server.me.mockRejectedValue(new Error('offline'))
    await auth.restore()
    expect(auth.snapshot()).toEqual({ kind: 'authenticated', session: user(), offline: true })
    server.me.mockResolvedValue(user()); await auth.restore()
    expect(auth.snapshot()).toEqual({ kind: 'authenticated', session: user() })
  })
  it('does not accept an old response after another user logged in', async () => {
    const old = deferred<Session>(), server = api()
    server.me.mockReturnValueOnce(old.promise).mockResolvedValueOnce(user('bob'))
    const auth = new AuthController(server), first = auth.restore()
    await auth.restore()
    old.resolve(user('alice')); await first
    expect(auth.snapshot()).toEqual({ kind: 'authenticated', session: user('bob') })
  })
  it('logout clears memory immediately and sends CSRF', async () => {
    const pending = deferred<undefined>(), server = api(), auth = new AuthController(server)
    await auth.restore()
    server.logout.mockReturnValue(pending.promise)
    const exit = auth.logout()
    expect(auth.snapshot()).toEqual({ kind: 'loading' })
    expect(server.logout).toHaveBeenCalledWith('csrf-alice')
    await auth.restore() // focus event must not undo an in-flight logout
    expect(server.me).toHaveBeenCalledTimes(1)
    pending.resolve(undefined); expect(await exit).toBe(true)
    expect(auth.snapshot().kind).toBe('anonymous')
  })
  it('an expired session during logout is still signed out', async () => {
    const server = api(), auth = new AuthController(server)
    await auth.restore()
    server.logout.mockRejectedValue(new AuthError(401, 'SESSION_EXPIRED'))
    expect(await auth.logout()).toBe(true)
    expect(auth.snapshot().kind).toBe('anonymous')
  })
  it('does not claim successful logout on a network failure', async () => {
    const server = api(), auth = new AuthController(server)
    await auth.restore()
    server.logout.mockRejectedValue(new Error('offline'))
    expect(await auth.logout()).toBe(false)
    expect(auth.snapshot().kind).toBe('error')
    expect(JSON.stringify(auth.snapshot())).not.toContain('alice')
  })
  it('an invalidated restore cannot bring back user data', async () => {
    const pending = deferred<Session>(), server = api()
    server.me.mockReturnValue(pending.promise)
    const auth = new AuthController(server), load = auth.restore()
    auth.lock()
    pending.resolve(user()); await load
    expect(auth.snapshot().kind).toBe('loading')
  })
  it('only redirects to the fixed Google authorization endpoint', async () => {
    const server = api(), auth = new AuthController(server)
    server.start.mockResolvedValue({ authorization_url: 'https://evil.example/' })
    expect(await auth.login()).toBeUndefined()
    expect(auth.snapshot().kind).toBe('error')
  })
  it('returns a verified authorization URL', async () => {
    const auth = new AuthController(api())
    expect(await auth.login()).toBe('https://accounts.google.com/o/oauth2/v2/auth?state=test')
  })
  it('represents missing Google configuration without fake sign-in', async () => {
    const server = api()
    server.me.mockRejectedValue(new AuthError(401, 'AUTH_REQUIRED'))
    server.config.mockResolvedValue({ google_enabled: false })
    const auth = new AuthController(server); await auth.restore()
    expect(auth.snapshot()).toEqual({ kind: 'anonymous', enabled: false })
  })
})

describe('API transport', () => {
  it('uses same-origin API, cookies and no-store; never adds bearer credentials', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(user()), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await authRequest('me')).toEqual(user())
    expect(fetch.mock.calls[0]).toEqual(['/api/auth/me', expect.objectContaining({ credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } })])
  })
  it('turns 401 into a typed authentication error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"SESSION_EXPIRED"}}', { status: 401 })))
    await expect(authRequest('me')).rejects.toMatchObject({ status: 401, code: 'SESSION_EXPIRED' })
  })
  it('accepts empty successful logout responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    expect(await authRequest('logout', { method: 'POST' })).toBeUndefined()
  })
})

 it('hides an authenticated user when the server confirms revocation, even after offline mode', async () => {
   const server = api(), auth = new AuthController(server)
   await auth.restore(); server.me.mockRejectedValueOnce(new Error('offline')); await auth.restore()
   server.me.mockRejectedValueOnce(new AuthError(401, 'SESSION_EXPIRED')); await auth.restore()
   expect(auth.snapshot().kind).toBe('anonymous'); expect(JSON.stringify(auth.snapshot())).not.toContain('alice')
 })
 it('does not retain an expired session on network failure', async () => {
   const server = api(), auth = new AuthController(server)
   server.me.mockResolvedValueOnce({ ...user(), expires_at: '2000-01-01T00:00:00Z' })
   await auth.restore(); server.me.mockRejectedValueOnce(new Error('offline')); await auth.restore()
   expect(auth.snapshot().kind).toBe('error'); expect(JSON.stringify(auth.snapshot())).not.toContain('alice')
 })
