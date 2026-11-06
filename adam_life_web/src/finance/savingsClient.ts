import { useCallback, useEffect, useRef, useState } from 'react'
import { FinanceError, financeRequest, parseMinor, type Account, type Currency } from './client'

export interface Allocation { account_id: string; amount_minor: string }
export interface Goal {
  id: string; name: string; currency: Currency; target_minor: string; mode: 'manual' | 'linked'; manual_minor: string | null
  deadline: string | null; status: 'active' | 'completed' | 'archived'; version: number; allocations: Allocation[]
  collected_minor: string; remaining_minor: string; monthly_minor: string | null; percent: number; overdue: boolean
}
export interface SavingsAccount extends Account { allocated_minor: string; free_minor: string; deficit_minor: string }
export interface Savings { as_of: string; goals: Goal[]; accounts: SavingsAccount[] }
export interface PlanMonth { month: string; target_minor: string | null; actual_minor: string; remaining_minor: string | null; percent: number | null }
export interface Plan { account_id: string; currency: Currency; revision: number; current: PlanMonth; history: PlanMonth[] }

export function nonnegativeMinor(text: string) {
  const amount = parseMinor(text, true)
  if (BigInt(amount) < 0n) throw new Error('Сумма не может быть отрицательной')
  return amount
}
export function goalFunding(mode: Goal['mode'], manual: string, allocations: Record<string, string>) {
  return mode === 'manual' ? { manual_minor: nonnegativeMinor(manual), allocations: [] } : {
    manual_minor: null,
    allocations: Object.entries(allocations).map(([account_id, text]) => ({ account_id, amount_minor: nonnegativeMinor(text || '0') })).filter(a => a.amount_minor !== '0'),
  }
}
export function goalHasDeficit(goal: Goal, accounts: SavingsAccount[]) {
  return goal.allocations.some(a => accounts.some(account => account.id === a.account_id && BigInt(account.deficit_minor) > 0n))
}

// Same authenticated transport as the ledger. No browser storage or demo fallback.
export function useSavingsResource<T>(path: string, csrf: string, refreshKey: unknown, onUnauthorized: () => void) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const unauthorized = useRef(onUnauthorized), generation = useRef(0), mounted = useRef(false)
  unauthorized.current = onUnauthorized
  const reload = useCallback(async () => {
    const current = ++generation.current
    setLoading(true); setError('')
    try {
      const next = await financeRequest<T>(path, csrf)
      if (mounted.current && current === generation.current) setData(next)
    } catch (e) {
      if (!mounted.current || current !== generation.current) return
      setData(null)
      if (e instanceof FinanceError && e.status === 401) unauthorized.current()
      else setError(e instanceof Error ? e.message : 'Не удалось загрузить данные')
    } finally { if (mounted.current && current === generation.current) setLoading(false) }
  }, [path, csrf])
  useEffect(() => { mounted.current = true; void reload(); return () => { mounted.current = false; generation.current++ } }, [reload, refreshKey])
  async function save(target: string, method: string, body: unknown) {
    try { await financeRequest(target, csrf, method, body) }
    catch (e) {
      if (e instanceof FinanceError && e.status === 401) { setData(null); unauthorized.current() }
      if (e instanceof FinanceError && e.status === 409) void reload()
      throw e instanceof FinanceError ? e : new Error('Ответ не получен. Обновите список перед повтором: запись могла сохраниться.')
    }
    // A failed refresh must never invite the user to submit a committed create twice.
    await reload()
  }
  return { data, error, loading, reload, save }
}
