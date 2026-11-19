import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createAppHistory, type AppRoute } from './appHistory'
import { Confirm } from '../finance/Editors'
import { Layout } from '../components/Layout'

const route = (view: AppRoute['view'], manage: AppRoute['manage'] = null): AppRoute => ({ view, manage })
function browser() {
  const entries: unknown[] = [null]; let index = 0
  const storage = new Map<string, string>()
  const port = {
    get state() { return entries[index] },
    pushState(state: unknown) { entries.splice(++index); entries.push(state) },
    replaceState(state: unknown) { entries[index] = state },
    back() { if (index > 0) index-- },
    forward() { if (index < entries.length - 1) index++ },
  }
  const memory = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
  return { port, memory, entries }
}
describe('app navigation', () => {
  it('disables unavailable moves and restores sections through browser history', () => {
    const b = browser(); const h = createAppHistory(b.port, b.memory, vi.fn())
    expect(h.snapshot()).toMatchObject({ canBack: false, canForward: false })
    h.back(); h.forward(); expect(b.entries).toHaveLength(1)
    h.go(route('transactions')); h.go(route('analytics'))
    h.back(); expect(h.snapshot().canBack).toBe(false) // No duplicate travel before popstate.
    h.restore(b.port.state)
    expect(h.snapshot()).toEqual({ route: route('transactions'), canBack: true, canForward: true })
    h.forward(); h.restore(b.port.state)
    expect(h.snapshot()).toEqual({ route: route('analytics'), canBack: true, canForward: false })
  })
  it('handles a native swipe/pop, accounts/categories, and new navigation after Back', () => {
    const b = browser(); const h = createAppHistory(b.port, b.memory, vi.fn())
    h.go(route('overview', 'accounts')); h.go(route('overview', 'categories'))
    b.port.back(); h.restore(b.port.state)
    expect(h.snapshot().route.manage).toBe('accounts')
    h.go(route('payments')); expect(h.snapshot().canForward).toBe(false)
    expect(b.entries).toHaveLength(3)
  })
  it('does not duplicate the current route and retains forward availability after reload', () => {
    const b = browser(); const h = createAppHistory(b.port, b.memory, vi.fn())
    h.go(route('overview')); expect(b.entries).toHaveLength(1)
    h.go(route('transactions')); h.go(route('analytics')); b.port.back()
    const reloaded = createAppHistory(b.port, b.memory, vi.fn())
    expect(reloaded.snapshot()).toMatchObject({ route: route('transactions'), canForward: true })
  })
  it('works when storage is blocked and does not serialize financial records', () => {
    const b = browser(); const blocked = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
    const h = createAppHistory(b.port, blocked, vi.fn()); h.go(route('transactions'))
    expect(h.snapshot().canBack).toBe(true)
    expect(JSON.stringify(b.port.state)).not.toContain('account_id')
    b.port.back(); h.restore(b.port.state); expect(h.snapshot().route.view).toBe('overview')
  })
  it('shows one compact accessible pair with native disabled buttons', () => {
    const html = renderToStaticMarkup(<Layout view="overview" onNavigate={() => {}} historyNavigation={{ canBack: false, canForward: true, back: () => {}, forward: () => {} }}>Page</Layout>)
    expect(html.match(/aria-label="Назад"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-label="Назад"[^>]*disabled/)
    expect(html).not.toMatch(/aria-label="Вперёд"[^>]*disabled/)
  })
})
describe('confirmation labels', () => {
  it.each(['Удалить', 'В архив', 'Восстановить'])('uses the explicit %s action and Cancel', label => {
    const action = vi.fn(async () => {})
    const html = renderToStaticMarkup(<Confirm title="Подтверждение" actionLabel={label} description="Тест" action={action} onClose={() => {}} />)
    expect(html).toContain(`>${label}</button>`); expect(html).toContain('>Отмена</button>'); expect(html).not.toContain('>Сохранить</button>')
    expect(action).not.toHaveBeenCalled()
  })
})
