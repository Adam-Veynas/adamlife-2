import { useEffect, useRef, useState } from 'react'
import { createAppHistory, type AppRoute } from './appHistory'

export function useAppNavigation(onRestore: () => void) {
  const [state, setState] = useState({ route: { view: 'overview', manage: null } as AppRoute, canBack: false, canForward: false })
  const controller = useRef<ReturnType<typeof createAppHistory> | null>(null)
  const restored = useRef(onRestore); restored.current = onRestore
  useEffect(() => {
    let storage: Storage | undefined
    try { storage = window.sessionStorage } catch { /* Safari may block storage. */ }
    const history = createAppHistory(window.history, storage, () => setState(history.snapshot()))
    controller.current = history; setState(history.snapshot())
    const pop = (event: PopStateEvent) => { history.restore(event.state); restored.current(); document.querySelector('main')?.scrollTo({ top: 0, behavior: 'instant' }) }
    window.addEventListener('popstate', pop)
    return () => { window.removeEventListener('popstate', pop); controller.current = null }
  }, [])
  return { ...state, go: (route: AppRoute) => controller.current?.go(route), back: () => controller.current?.back(), forward: () => controller.current?.forward() }
}
