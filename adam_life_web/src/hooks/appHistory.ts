import type { View } from '../domain/finance'

export type AppRoute = { view: View; manage: 'accounts' | 'categories' | null }
type Entry = { chain: string; index: number; route: AppRoute }
type BrowserHistory = Pick<History, 'state' | 'pushState' | 'replaceState' | 'back' | 'forward'>
const key = 'adamlife.navigation'
const initial: AppRoute = { view: 'overview', manage: null }
function entry(value: unknown): Entry | null {
  const item = (value as Record<string, Entry> | null)?.[key]
  return item && typeof item.chain === 'string' && Number.isSafeInteger(item.index) && item.index >= 0
    && ['overview', 'transactions', 'analytics', 'payments'].includes(item.route?.view)
    && [null, 'accounts', 'categories'].includes(item.route.manage) ? item : null
}

// Browser history stores only screen names, never accounts, operations or callbacks.
export function createAppHistory(history: BrowserHistory, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, notify: () => void) {
  let current = entry(history.state) ?? { chain: `${Date.now()}-${Math.random()}`, index: 0, route: initial }
  let end = current.index, travelling = false
  try { end = Math.max(end, Number(storage?.getItem(key + current.chain)) || 0) } catch { /* Storage may be unavailable in private browsing. */ }
  const write = (replace = false) => {
    history[replace ? 'replaceState' : 'pushState']({ ...history.state, [key]: current }, '')
    try { storage?.setItem(key + current.chain, String(end)) } catch { /* In-memory navigation still works. */ }
  }
  write(true)
  return {
    snapshot: () => ({ route: current.route, canBack: !travelling && current.index > 0, canForward: !travelling && current.index < end }),
    go(route: AppRoute) {
      if (travelling || (route.view === current.route.view && route.manage === current.route.manage)) return
      current = { ...current, index: current.index + 1, route }; end = current.index
      write(); notify()
    },
    restore(state: unknown) {
      const next = entry(state)
      travelling = false
      if (next?.chain === current.chain) current = next
      else { current = { chain: `${Date.now()}-${Math.random()}`, index: 0, route: next?.route ?? initial }; end = 0; write(true) }
      notify()
    },
    back() { if (!travelling && current.index > 0) { travelling = true; notify(); history.back() } },
    forward() { if (!travelling && current.index < end) { travelling = true; notify(); history.forward() } },
  }
}
