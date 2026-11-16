import { reportingKind, reportingCategory, reportingAmount, type Account, type Category, type Currency, type Operation } from './client'

export type AnalyticsPeriod = 'month' | 'previous' | '3' | '6' | '12' | 'custom'
export interface DateRange { from: string; to: string }
export interface AnalyticsFilter extends DateRange { currency: Currency; accounts: string[] }
export interface CategorySlice { id: string | null; name: string; amount: bigint; previous: bigint; share: number; color: string }
export interface FlowPoint { date: string; label: string; income: bigint; expense: bigint }
const day = 86400000
const iso = (date: Date) => date.toISOString().slice(0, 10)
const utc = (date: string) => new Date(date + 'T00:00:00Z')
function monthStart(date: string, offset = 0) { const d = utc(date); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1))) }
function monthEnd(date: string, offset = 0) { const d = utc(date); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset + 1, 0))) }
function shiftDays(date: string, count: number) { return iso(new Date(utc(date).getTime() + count * day)) }
function shiftMonths(date: string, count: number) {
  const start = monthStart(date, count), end = monthEnd(start)
  return start.slice(0, 8) + String(Math.min(utc(date).getUTCDate(), utc(end).getUTCDate())).padStart(2, '0')
}
export function validRange(range: DateRange) {
  return [range.from, range.to].every(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(utc(value).getTime()) && iso(utc(value)) === value) && range.from <= range.to
}
export function analyticsRanges(period: AnalyticsPeriod, today: string, custom: DateRange) {
  let current: DateRange, previous: DateRange
  if (period === 'custom') {
    if (!validRange(custom)) return null
    current = custom
    const count = (utc(custom.to).getTime() - utc(custom.from).getTime()) / day + 1
    previous = { from: shiftDays(custom.from, -count), to: shiftDays(custom.from, -1) }
  } else if (period === 'previous') {
    current = { from: monthStart(today, -1), to: monthEnd(today, -1) }
    previous = { from: monthStart(today, -2), to: monthEnd(today, -2) }
  } else {
    const months = period === 'month' ? 1 : Number(period)
    current = { from: monthStart(today, 1 - months), to: today }
    previous = { from: monthStart(current.from, -months), to: today === monthEnd(today) ? monthEnd(today, -months) : shiftMonths(today, -months) }
  }
  return { current, previous }
}
// Select only real income/expense types, even when one side of a transfer is selected.
export function analyticsRows(operations: Operation[], filter: AnalyticsFilter) {
  return operations.filter(row => reportingKind(row) !== null && reportingKind(row) !== 'transfer' && row.currency === filter.currency &&
    (!filter.accounts.length || filter.accounts.includes(row.account_id)) && row.occurred_on >= filter.from && row.occurred_on <= filter.to)
}
export function comparisonText(current: bigint, previous: bigint) {
  if (previous <= 0n) return 'Нет базы для сравнения'
  const difference = current - previous
  const tenths = ((difference < 0n ? -difference : difference) * 1000n + previous / 2n) / previous
  if (difference === 0n) return 'Без изменений'
  return `${difference < 0n ? '−' : '+'}${tenths / 10n}${tenths % 10n ? ',' + tenths % 10n : ''}% к предыдущему периоду`
}
export function sliceColor(id: string | null) {
  let hash = 0
  for (const char of id ?? 'uncategorized') hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0
  return `var(--category-${hash % 8 + 1})`
}
export function categorySlices(current: Operation[], previous: Operation[], categories: Category[], kind: 'income' | 'expense'): CategorySlice[] {
  const values = new Map<string | null, { amount: bigint; previous: bigint }>()
  for (const [rows, field] of [[current, 'amount'], [previous, 'previous']] as const) {
    for (const row of rows) {
      if (reportingKind(row) !== kind) continue
      const category = reportingCategory(row)
      const entry = values.get(category) ?? { amount: 0n, previous: 0n }
      entry[field] += reportingAmount(row); values.set(category, entry)
    }
  }
  const total = [...values.values()].reduce((sum, entry) => sum + (entry.amount > 0n ? entry.amount : 0n), 0n)
  return [...values].map(([id, value]) => ({ id, ...value, name: categories.find(c => c.id === id)?.name ?? 'Без категории',
    share: total && value.amount > 0n ? Number(value.amount * 1000000n / total) / 1000000 : 0, color: sliceColor(id) }))
    .sort((a, b) => a.amount === b.amount ? a.name.localeCompare(b.name, 'ru') : a.amount > b.amount ? -1 : 1)
}
export function flowPoints(rows: Operation[], range: DateRange): FlowPoint[] {
  if (!validRange(range)) return []
  const monthly = range.from.slice(0, 7) !== range.to.slice(0, 7)
  const values = new Map<string, { income: bigint; expense: bigint }>()
  for (const row of rows) {
    const kind = reportingKind(row)
    if (!kind || kind === 'transfer' || row.occurred_on < range.from || row.occurred_on > range.to) continue
    const key = monthly ? row.occurred_on.slice(0, 7) + '-01' : row.occurred_on
    const item = values.get(key) ?? { income: 0n, expense: 0n }; item[kind] += reportingAmount(row); values.set(key, item)
  }
  const result: FlowPoint[] = []
  for (let date = monthly ? monthStart(range.from) : range.from; date <= range.to; date = monthly ? monthStart(date, 1) : shiftDays(date, 1)) {
    result.push({ date, label: utc(date).toLocaleDateString('ru-RU', { timeZone: 'UTC', ...(monthly ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' }) }), ...(values.get(date) ?? { income: 0n, expense: 0n }) })
  }
  return result
}
export function depositGroups(accounts: Account[], selected: string[]) {
  return (['KZT', 'USD', 'EUR'] as const).map(currency => {
    const items = accounts.filter(a => a.kind === 'deposit' && a.currency === currency && (!selected.length || selected.includes(a.id)))
    return { currency, items, total: items.reduce((sum, a) => sum + BigInt(a.balance_minor), 0n) }
  }).filter(group => group.items.length)
}

export interface AnalyticsDrilldown extends AnalyticsFilter { kind: 'income' | 'expense'; category: string | null }
export function drilldownRows(rows: Operation[], filter: AnalyticsDrilldown) {
  return analyticsRows(rows, filter).filter(row => reportingKind(row) === filter.kind && reportingCategory(row) === filter.category)
}
