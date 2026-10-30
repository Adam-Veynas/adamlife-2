import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import { ArrowRight, LogOut, ShieldCheck } from 'lucide-react'
import { Brand, Layout, navigation } from '../components/Layout'
import type { View } from '../domain/finance'
import type { User } from './client'
import { AuthController } from './controller'

// The demo repository and demo money are not loaded by an authenticated page.
const Demo = lazy(() => import('../App').then(module => ({ default: module.App })))
const controller = new AuthController()

function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [view, setView] = useState<View>('overview')
  const title = navigation.find(item => item.id === view)!.title
  return <Layout view={view} onNavigate={setView} accountControl={<button className="button secondary auth-logout" onClick={onLogout}><LogOut size={16} />Выйти</button>}>
    <div className="page-content"><header className="page-header"><div><h1>{title}</h1><p>{user.display_name}</p></div></header>
      <section className="auth-workspace"><span className="auth-symbol"><ShieldCheck size={26} /></span>
        <h2>{view === 'overview' ? 'Ваше личное пространство' : title + ': пока нет данных'}</h2>
        <p>Вы вошли в свой аккаунт. Учёт финансов на сервере ещё не подключён — здесь не используются демонстрационные операции и остатки.</p>
        {user.email && <span className="auth-email">{user.email}</span>}
      </section>
    </div>
  </Layout>
}

export function AuthRoot() {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const [callbackError] = useState(() => {
    const value = new URLSearchParams(window.location.search).get('auth_error')
    return value === 'cancelled' ? 'Вход отменён. Вы можете попробовать ещё раз.' : value ? 'Не удалось завершить вход. Начните ещё раз.' : ''
  })
  useEffect(() => {
    // Keep the initializer pure: StrictMode can call it twice.
    const url = new URL(window.location.href)
    if (url.searchParams.has('auth_error')) {
      url.searchParams.delete('auth_error')
      window.history.replaceState(null, '', url.pathname + url.search + url.hash)
    }
    void controller.restore()
    const refresh = () => { if (document.visibilityState === 'visible' && controller.snapshot().kind !== 'demo') void controller.restore() }
    const hide = () => { if (controller.snapshot().kind !== 'demo') controller.lock() }
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('adamlife-auth')
    if (channel) channel.onmessage = () => { if (controller.snapshot().kind !== 'demo') { controller.lock(); refresh() } }
    const interval = window.setInterval(refresh, 60000)
    window.addEventListener('focus', refresh)
    window.addEventListener('pageshow', refresh)
    window.addEventListener('pagehide', hide)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      channel?.close(); clearInterval(interval)
      window.removeEventListener('focus', refresh); window.removeEventListener('pageshow', refresh)
      window.removeEventListener('pagehide', hide); document.removeEventListener('visibilitychange', refresh)
      controller.lock()
    }
  }, [])
  useEffect(() => {
    if (state.kind !== 'authenticated') return
    const delay = Math.max(0, Date.parse(state.session.expires_at) - Date.now())
    const timer = window.setTimeout(() => void controller.restore(), Math.min(delay, 2147483647))
    return () => clearTimeout(timer)
  }, [state])
  async function logout() {
    if (await controller.logout() && typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('adamlife-auth'); channel.postMessage('signed-out'); channel.close()
    }
  }
  if (state.kind === 'authenticated') return <Workspace key={state.session.user.id} user={state.session.user} onLogout={() => void logout()} />
  if (state.kind === 'demo') return <><div className="auth-demo-bar"><span>Демонстрация · не данные аккаунта</span><button onClick={() => void controller.restore()}>Завершить просмотр</button></div><Suspense fallback={<div className="auth-screen">Загрузка демонстрации…</div>}><Demo /></Suspense></>
  return <main className="auth-screen"><section className="auth-card"><Brand />
    <span className="auth-eyebrow">ЛИЧНОЕ ФИНАНСОВОЕ ПРОСТРАНСТВО</span>
    <h1>Всё важное.<br /><span>Под вашим контролем.</span></h1>
    <p>Войдите, чтобы открыть свой аккаунт AdamLife.</p>
    {state.kind === 'loading' ? <div className="auth-loading" role="status"><span className="auth-spinner" />Проверяем сессию…</div> : <>
      {(state.kind === 'error' || callbackError) && <div role="alert" className="auth-error">{state.kind === 'error' ? state.message : callbackError}</div>}
      {state.kind === 'error' ? <button className="button primary auth-main-button" onClick={() => void controller.restore()}>Повторить проверку</button> : <>
        <button className="button primary auth-main-button" disabled={!state.enabled} onClick={() => void controller.login().then(url => { if (url) window.location.assign(url) })}>Продолжить с Google<ArrowRight size={18} /></button>
        {!state.enabled && <p className="auth-help">Вход появится после подключения Google. Пока доступен просмотр прототипа.</p>}
      </>}
      <button className="auth-demo-link" onClick={controller.demo}>Посмотреть демонстрацию</button>
    </>}
    <div className="auth-footnote"><ShieldCheck size={17} /><span>Личное пространство с защищённой сессией</span></div>
  </section></main>
}
