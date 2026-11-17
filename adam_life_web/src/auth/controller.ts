import { AuthError, authAPI, type Session } from './client'

export type AuthState =
  | { kind: 'loading' }
  | { kind: 'anonymous'; enabled: boolean }
  | { kind: 'authenticated'; session: Session; offline?: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'demo' }

/** Memory only. Generation checks discard responses from a previous login/logout. */
export class AuthController {
  private state: AuthState = { kind: 'loading' }
  private generation = 0
  private pendingAction = false
  private listeners = new Set<() => void>()
  constructor(private api = authAPI) {}
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(state: AuthState) { this.state = state; this.listeners.forEach(listener => listener()) }
  lock = () => { this.generation++; this.pendingAction = false; this.set({ kind: 'loading' }) }
  demo = () => { this.generation++; this.set({ kind: 'demo' }) }
  async restore() {
    if (this.pendingAction) return
    const generation = ++this.generation
    // Keep an already authenticated editor mounted during periodic validation.
    // A rejected validation still clears user data below.
    if (this.state.kind !== 'authenticated') this.set({ kind: 'loading' })
    try {
      const session = await this.api.me()
      if (generation === this.generation) this.set({ kind: 'authenticated', session })
    } catch (error) {
      if (generation !== this.generation) return
      if (error instanceof AuthError && error.status === 401) {
        try {
          const config = await this.api.config()
          if (generation === this.generation) this.set({ kind: 'anonymous', enabled: config.google_enabled })
        } catch {
          if (generation === this.generation) this.set({ kind: 'error', message: 'Не удалось связаться с сервером. Проверьте соединение.' })
        }
      } else if (this.state.kind === 'authenticated' && Date.parse(this.state.session.expires_at) > Date.now()) {
        // A transport failure is not a revoked session; API writes still require server auth.
        this.set({ ...this.state, offline: true })
      } else this.set({ kind: 'error', message: 'Не удалось проверить сессию. Повторите проверку соединения.' })
    }
  }
  async login(): Promise<string | undefined> {
    if (this.pendingAction) return
    this.pendingAction = true
    const generation = ++this.generation
    this.set({ kind: 'loading' })
    try {
      const { authorization_url: url } = await this.api.start()
      const target = new URL(url)
      if (target.origin !== 'https://accounts.google.com' || target.pathname !== '/o/oauth2/v2/auth') throw new Error('Invalid redirect')
      return generation === this.generation ? url : undefined
    } catch {
      this.pendingAction = false
      if (generation === this.generation) this.set({ kind: 'error', message: 'Не удалось начать вход через Google. Попробуйте ещё раз.' })
    }
  }
  async logout(): Promise<boolean> {
    if (this.pendingAction) return false
    this.pendingAction = true
    const csrf = this.state.kind === 'authenticated' ? this.state.session.csrf_token : null
    const generation = ++this.generation
    this.set({ kind: 'loading' })
    if (!csrf) { this.pendingAction = false; await this.restore(); return false }
    try {
      await this.api.logout(csrf)
    } catch (error) {
      if (!(error instanceof AuthError && error.status === 401)) {
        this.pendingAction = false
        if (generation === this.generation) this.set({ kind: 'error', message: 'Выход не подтверждён сервером. Проверьте соединение и повторите попытку.' })
        return false
      }
    }
    this.pendingAction = false
    if (generation !== this.generation) return false
    this.set({ kind: 'anonymous', enabled: true })
    return true
  }
}
