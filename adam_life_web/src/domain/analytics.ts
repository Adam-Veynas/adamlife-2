import { monthLabel, queryTransactions, shiftMonth, totals, type FinanceFilter, type Transaction } from './finance'

export function spendingComparison(current: number, previous: number, hasPreviousData: boolean) {
  if (!hasPreviousData) return { percent: null, message: 'Нет данных для сравнения' }
  if (previous === 0) return { percent: null, message: current === 0 ? 'Расходов в обоих периодах нет' : 'В предыдущем периоде нет расходов — процент не рассчитывается' }
  const percent = Math.round((current - previous) / previous * 1000) / 10
  const text = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(percent)
  return { percent, message: `${percent > 0 ? '+' : ''}${text}% к предыдущему периоду` }
}
export function categoryComparison(items: Transaction[], filter: FinanceFilter, category: string) {
  const currentRows = queryTransactions(items, filter)
  const currentMinor = totals(currentRows.filter(row => row.category === category)).expense
  if (filter.period === 'all') return { currentMinor, previousMinor: null, percent: null, previousLabel: '', message: 'За всё время нет сопоставимого предыдущего периода' }
  const previousFilter = { ...filter, month: shiftMonth(filter.month, filter.period === 'quarter' ? -3 : -1) }
  const previousRows = queryTransactions(items, previousFilter).filter(row => row.type !== 'transfer')
  const previousMinor = totals(previousRows.filter(row => row.category === category)).expense
  const previousLabel = filter.period === 'month' ? monthLabel(previousFilter.month) : `${monthLabel(shiftMonth(previousFilter.month, -2))} — ${monthLabel(previousFilter.month)}`
  return { currentMinor, previousMinor, previousLabel, ...spendingComparison(currentMinor, previousMinor, previousRows.length > 0) }
}
/** x is in SVG coordinates, after the screen CTM has been inverted. */
export function chartPointIndex(x: number, count: number): number {
  if (count <= 1 || !Number.isFinite(x)) return 0
  return Math.min(count - 1, Math.max(0, Math.round((x - 12) / 560 * (count - 1))))
}
