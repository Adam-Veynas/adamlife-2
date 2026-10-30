import { describe, expect, it } from 'vitest'
import { amountInput, categoryTotals, createDemoData, demoImportRows, filterPeriod, money, parseAmount, totals, type Transaction } from './finance'

const row = (id: string, date: string, amountMinor: number, type: Transaction['type'] = 'expense'): Transaction => ({ id, date, amountMinor, type, category: 'Продукты', comment: '', source: 'manual' })

describe('точность денежных сумм', () => {
  it('разбирает запятую, точку и разделители без потери тиынов', () => {
    expect(parseAmount('1 234,56')).toBe(123456)
    expect(parseAmount('1\u202f234.01')).toBe(123401)
    expect(amountInput(123456)).toBe('1234,56')
    expect(parseAmount(amountInput(123456))).toBe(123456)
  })
  it.each(['-1', '0', 'NaN', 'Infinity', '1.234', '', '1e3', '1,2,3', '100000000001'])('отклоняет неверную сумму %s', value => {
    expect(parseAmount(value)).toBeNull()
  })
  it('складывает суммы в целых единицах', () => {
    expect(totals([row('1', '2026-10-01', 10, 'income'), row('2', '2026-10-02', 20, 'income'), row('3', '2026-10-03', 3)])).toEqual({ income: 30, expense: 3, net: 27 })
  })
  it('компактная подпись графика не падает на суммах с тиынами', () => {
    expect(() => money(12345, { compact: true })).not.toThrow()
    expect(money(12345)).toContain('123,45')
  })
})

describe('периоды и статистика', () => {
  const items = [row('old', '1999-01-01', 100), row('july', '2026-07-31', 200), row('aug', '2026-08-01', 300), row('oct', '2026-10-31', 400), row('future', '2026-11-01', 500)]
  const month = new Date(2026, 9, 1)
  it('месяц имеет обе границы и исключает следующий месяц', () => {
    expect(filterPeriod(items, month, 'month').map(item => item.id)).toEqual(['oct'])
  })
  it('три месяца — текущий и два предыдущих календарных', () => {
    expect(filterPeriod(items, month, 'quarter').map(item => item.id)).toEqual(['oct', 'aug'])
  })
  it('всё время не обрезает старые записи', () => { expect(filterPeriod(items, month, 'all')).toHaveLength(5) })
  it('корректно проходит границу года', () => {
    expect(filterPeriod([row('dec', '2025-12-31', 100), row('jan', '2026-01-01', 200)], new Date(2026, 0, 1), 'quarter')).toHaveLength(2)
  })
  it('расходы по категориям не включают доходы', () => {
    const categories = categoryTotals([row('e1', '2026-10-01', 101), row('e2', '2026-10-01', 202), row('i', '2026-10-01', 900, 'income')])
    expect(categories[0].amount).toBe(303)
    expect(categories[0].share).toBe(1)
  })
  it('пустой период даёт нулевые суммы', () => { expect(totals([])).toEqual({ income: 0, expense: 0, net: 0 }); expect(categoryTotals([])).toEqual([]) })
})

describe('прототип', () => {
  it('содержит реалистичные данные для разных месяцев и уникальные ID', () => {
    const data = createDemoData(new Date(2026, 9, 22))
    expect(new Set(data.transactions.map(item => item.id)).size).toBe(data.transactions.length)
    expect(filterPeriod(data.transactions, new Date(2026, 9, 1), 'month').length).toBeGreaterThan(10)
    expect(filterPeriod(data.transactions, new Date(2026, 8, 1), 'month').length).toBeGreaterThan(0)
  })
  it('демоимпорт имеет стабильные ID для предотвращения повторов', () => {
    expect(demoImportRows(new Date(2026, 9, 1)).map(item => item.id)).toEqual(demoImportRows(new Date(2026, 9, 1)).map(item => item.id))
    expect(demoImportRows(new Date(2026, 9, 1)).every(item => item.source === 'demo-import')).toBe(true)
  })
})
