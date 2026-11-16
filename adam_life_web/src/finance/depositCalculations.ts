import type { Account, Category, Operation } from './client'

export const DEPOSIT_INTEREST_CATEGORY = 'Проценты по депозиту'
export type DepositPeriod = 3 | 6 | 12
const DAY = 86400000

export function day(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const stamp = Date.parse(value + 'T00:00:00Z')
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp : null
}

export function addCalendarMonths(value: string, months: DepositPeriod): string | null {
  const stamp = day(value)
  if (stamp === null) return null
  const result = new Date(stamp), originalDay = result.getUTCDate()
  result.setUTCDate(1)
  result.setUTCMonth(result.getUTCMonth() + months + 1)
  result.setUTCDate(0)
  result.setUTCDate(Math.min(originalDay, result.getUTCDate()))
  const date = result.toISOString().slice(0, 10)
  return day(date) === null ? null : date
}

type Forecast = { available: false; message: string } | { available: true; end: string; days: number; income: bigint; total: bigint; ended: boolean }
export function depositForecast(account: Account, asOf: string, months: DepositPeriod): Forecast {
  if (account.annual_rate == null || !/^\d{1,5}(?:\.\d{1,4})?$/.test(account.annual_rate)) return { available: false, message: 'Укажите годовую ставку в параметрах депозита.' }
  if (!account.deposit_type) return { available: false, message: 'Укажите тип депозита для расчёта прогноза.' }
  const start = day(asOf)
  if (start === null) return { available: false, message: 'Обновите данные: дата расчёта недоступна.' }
  const end = account.deposit_ends_on || (account.deposit_type === 'savings' ? addCalendarMonths(asOf, months) : null)
  if (!end) return { available: false, message: 'Укажите дату окончания срочного депозита.' }
  const finish = day(end)
  if (finish === null) return { available: false, message: 'Проверьте дату окончания депозита.' }
  const principal = BigInt(account.balance_minor)
  if (principal < 0n) return { available: false, message: 'Прогноз недоступен при отрицательном остатке.' }
  const days = Math.max(0, (finish - start) / DAY)
  const [whole, fraction = ''] = account.annual_rate.split('.')
  const rate = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'))
  const denominator = 100n * 10000n * 365n
  // Simple ACT/365 interest. Round once, to the nearest minor unit; no floating money.
  const income = (principal * rate * BigInt(days) + denominator / 2n) / denominator
  return { available: true, end, days, income, total: principal + income, ended: finish <= start }
}

export function depositMovements(account: Account, operations: Operation[], categories: Category[], asOf: string) {
  const interestCategories = new Set(categories.filter(c => c.kind === 'income' && c.name === DEPOSIT_INTEREST_CATEGORY).map(c => c.id))
  let added = 0n, withdrawn = 0n, interest = 0n
  for (const op of operations) {
    if (op.currency !== account.currency || op.occurred_on < account.opening_date || op.occurred_on > asOf) continue
    if (op.kind === 'transfer') {
      if (op.destination_account_id === account.id) added += BigInt(op.amount_minor)
      if (op.account_id === account.id) withdrawn += BigInt(op.amount_minor)
    } else if (op.kind === 'income' && !op.adjustment_type && op.account_id === account.id && op.category_id && interestCategories.has(op.category_id)) {
      interest += BigInt(op.amount_minor)
    }
  }
  return { opening: BigInt(account.opening_balance_minor), added, withdrawn, interest, current: BigInt(account.balance_minor) }
}
