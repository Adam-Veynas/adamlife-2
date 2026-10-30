import { describe, expect, it } from 'vitest'
import { categoryComparison, chartPointIndex } from './analytics'
import type { FinanceFilter, Transaction } from './finance'

const row = (id: string, date: string, amountMinor: number, extra: Partial<Transaction> = {}): Transaction => ({ id, date, amountMinor, type: 'expense', category: 'Продукты', accountId: 'kaspi', comment: '', source: 'demo', ...extra })
const filter: FinanceFilter = { month: new Date(2026, 9, 1), period: 'month', account: 'kaspi' }
describe('сравнение категорий с равным предыдущим периодом', () => {
  it('сравнивает месяц с предыдущим месяцем и учитывает выбранный счёт', () => {
    const result = categoryComparison([row('oct', '2026-10-10', 15000), row('sep', '2026-09-10', 10000), row('other', '2026-09-10', 50000, { accountId: 'freedom' }), row('transfer', '2026-10-10', 90000, { type: 'transfer', toAccountId: 'cash' })], filter, 'Продукты')
    expect(result).toMatchObject({ currentMinor: 15000, previousMinor: 10000, percent: 50, previousLabel: 'Сентябрь 2026' })
  })
  it('три месяца сравниваются с предыдущими тремя без пересечения диапазонов', () => {
    const result = categoryComparison([row('may', '2026-05-01', 10000), row('jul', '2026-07-31', 10000), row('aug', '2026-08-01', 4000), row('oct', '2026-10-31', 6000), row('outside', '2026-04-30', 99999), row('future', '2026-11-01', 99999)], { ...filter, period: 'quarter' }, 'Продукты')
    expect(result).toMatchObject({ currentMinor: 10000, previousMinor: 20000, percent: -50, previousLabel: 'Май 2026 — Июль 2026' })
  })
  it('нет предыдущих данных — нет ложного 0% или бесконечности', () => {
    const result = categoryComparison([row('a', '2026-10-10', 5000)], filter, 'Продукты')
    expect(result.percent).toBeNull(); expect(result.message).toBe('Нет данных для сравнения')
  })
  it('нулевые расходы при существующих данных отличаются от отсутствующей истории', () => {
    const result = categoryComparison([row('a', '2026-10-10', 5000), row('income', '2026-09-10', 10000, { type: 'income' })], filter, 'Продукты')
    expect(result.previousMinor).toBe(0); expect(result.percent).toBeNull(); expect(result.message).toContain('процент не рассчитывается')
  })
  it('исчезновение расходов даёт -100%, ноль в обоих периодах не даёт выдуманного процента', () => {
    expect(categoryComparison([row('prev', '2026-09-10', 5000)], filter, 'Продукты').percent).toBe(-100)
    expect(categoryComparison([row('prev', '2026-09-10', 5000, { category: 'Жильё' })], filter, 'Продукты')).toMatchObject({ percent: null, message: 'Расходов в обоих периодах нет' })
  })
  it('для всего времени не подставляет произвольный предыдущий месяц', () => {
    expect(categoryComparison([row('a', '2026-10-10', 5000)], { ...filter, period: 'all' }, 'Продукты')).toMatchObject({ currentMinor: 5000, previousMinor: null, percent: null, message: 'За всё время нет сопоставимого предыдущего периода' })
  })
  it('переход года сравнивает январь с декабрём', () => {
    expect(categoryComparison([row('jan', '2026-01-01', 10100), row('dec', '2025-12-31', 10000)], { ...filter, month: new Date(2026, 0, 1) }, 'Продукты').percent).toBe(1)
  })
})
describe('прямое нажатие на график выбирает ближайшую дату', () => {
  it.each([[12, 0], [292, 11], [572, 21], [-100, 0], [1000, 21]])('координата %s → индекс %s', (x, index) => { expect(chartPointIndex(x, 22)).toBe(index) })
  it('одна точка и некорректная координата безопасны', () => { expect(chartPointIndex(572, 1)).toBe(0); expect(chartPointIndex(NaN, 22)).toBe(0) })
})
