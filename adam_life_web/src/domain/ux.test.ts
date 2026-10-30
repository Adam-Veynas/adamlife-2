import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Analytics } from '../components/Pages'
import { accountBalances, createDemoData, dailySeries, expenseChange, localDate, periodBounds, queryTransactions, totals, validDate, type PrototypeData, type Transaction } from './finance'
import { prepareData } from '../data/prototypeRepository'
import { paymentOccurrences, paymentTotals, type Payment } from './payments'
import { createImportExample, importOutcome } from './import'

const month = new Date(2026, 9, 1), today = new Date(2026, 9, 22)
const row = (id: string, overrides: Partial<Transaction> = {}): Transaction => ({ id, type: 'expense', amountMinor: 12345, date: '2026-10-10', category: 'Продукты', comment: 'Покупка', source: 'manual', accountId: 'kaspi', ...overrides })
const payment: Payment = { id: 'p', title: 'Подписка', amountMinor: 123456, dueDate: '2026-01-31', frequency: 'monthly', kind: 'Подписка', accountId: 'kaspi', paid: {} }

describe('счета и миграция', () => {
  it('расширяет старые данные без потери операций и общего остатка', () => {
    const original = createDemoData(today), migrated = prepareData(original)
    expect(migrated.transactions.map(({ accountId: _, ...item }) => item)).toEqual(original.transactions)
    expect(migrated.accounts?.reduce((sum, account) => sum + account.openingBalanceMinor, 0)).toBe(original.openingBalanceMinor)
    expect(accountBalances(migrated).reduce((sum, account) => sum + account.balance, 0)).toBe(original.openingBalanceMinor + totals(original.transactions).net)
    expect(prepareData(migrated)).toEqual(migrated)
  })
  it('перевод меняет два счёта, но не доходы/расходы и общий баланс', () => {
    const data: PrototypeData = { version: 1, openingBalanceMinor: 100000, accounts: [{ id: 'kaspi', openingBalanceMinor: 100000 }, { id: 'freedom', openingBalanceMinor: 0 }, { id: 'cash', openingBalanceMinor: 0 }], transactions: [row('transfer', { type: 'transfer', toAccountId: 'freedom', amountMinor: 12345 })] }
    expect(accountBalances(data).map(item => item.balance)).toEqual([87655, 12345, 0])
    expect(totals(data.transactions)).toEqual({ income: 0, expense: 0, net: 0 })
  })
  it('не восстанавливает удалённые/пустые платежи при загрузке', () => { expect(prepareData({ ...createDemoData(today), payments: [] }).payments).toEqual([]) })
})
describe('единая фильтрация', () => {
  const items = [row('a'), row('b', { accountId: 'freedom' }), row('c', { category: 'Жильё' }), row('d', { date: '2026-09-10' }), row('e', { type: 'income' }), row('f', { comment: 'Другая покупка', amountMinor: 100 })]
  const filter = { month, period: 'month' as const, account: 'kaspi' as const }
  it('комбинирует период, счёт, категорию, тип и поиск', () => {
    expect(queryTransactions(items, { ...filter, category: 'Продукты', kind: 'expense', query: 'Другая' }).map(item => item.id)).toEqual(['f'])
  })
  it('сортирует по сумме в обе стороны', () => {
    expect(queryTransactions(items, { ...filter, sort: 'amount-asc' })[0].id).toBe('f')
    expect(queryTransactions(items, { ...filter, sort: 'amount-desc' }).at(-1)?.id).toBe('f')
  })
  it('показывает перевод в обоих счетах, не удваивая операцию', () => {
    const transfer = row('t', { type: 'transfer', toAccountId: 'freedom' })
    expect(queryTransactions([transfer], { ...filter, account: 'freedom' })).toHaveLength(1)
    expect(queryTransactions([transfer], { ...filter, account: 'all' })).toHaveLength(1)
  })
  it('разделяет ключи соседних графиков при обновлении фильтров', () => {
    const content = Analytics({ items, filter, onFilter: () => {}, onCategory: () => {} })
    const children = content.props.children as unknown[]
    const grid = children[3] as { props: { children: { key: string }[] } }
    expect(new Set(grid.props.children.map(child => child.key)).size).toBe(grid.props.children.length)
    const html = renderToStaticMarkup(content)
    expect(html.match(/class="panel category-panel/g)).toHaveLength(1)
    expect(html.match(/class="panel cashflow-panel/g)).toHaveLength(1)
  })
})
describe('даты, динамика и среднее', () => {
  it('не принимает нормализованные несуществующие даты', () => {
    expect(validDate('2026-02-31')).toBe(false); expect(validDate('2024-02-29')).toBe(true); expect(validDate('2025-02-29')).toBe(false)
  })
  it('считает текущий месяц по прошедшим дням, прошлый — по полному', () => {
    expect(periodBounds([], month, 'month', today).days).toBe(22)
    expect(periodBounds([], new Date(2026, 8, 1), 'month', today).days).toBe(30)
    expect(periodBounds([], month, 'quarter', today).days).toBe(31 + 30 + 22)
  })
  it('по дням и накопительно совпадают с исходными суммами без переводов', () => {
    const items = [row('a'), row('b', { amountMinor: 55, date: '2026-10-11' }), row('t', { type: 'transfer', toAccountId: 'cash' })]
    expect(dailySeries(items, month, 'month', 'expense', false, today).reduce((sum, item) => sum + item.amount, 0)).toBe(12400)
    expect(dailySeries(items, month, 'month', 'expense', true, today).at(-1)?.amount).toBe(12400)
    expect(dailySeries(items, month, 'month', 'income', true, today).at(-1)?.amount).toBe(0)
  })
  it('не теряет введённые будущие операции текущего месяца на графике', () => {
    expect(dailySeries([row('future', { date: '2026-10-31' })], month, 'month', 'expense', true, today).at(-1)?.amount).toBe(12345)
  })
  it('корректно показывает нулевую базу и снижение', () => {
    expect(expenseChange(0, 0)).toBe('Без изменений'); expect(expenseChange(100, 0)).toContain('Нет базы'); expect(expenseChange(50, 100)).toContain('-50%')
  })
})
describe('ежемесячные обязательства', () => {
  it('переносит 31 число на конец февраля без сдвига следующих месяцев', () => {
    expect(paymentOccurrences([payment], new Date(2026, 1, 1), today)[0].date).toBe('2026-02-28')
    expect(paymentOccurrences([payment], new Date(2026, 2, 1), today)[0].date).toBe('2026-03-31')
  })
  it('не создаёт платежи до начальной даты; разовый не повторяется', () => {
    expect(paymentOccurrences([payment], new Date(2025, 11, 1), today)).toHaveLength(0)
    expect(paymentOccurrences([{ ...payment, frequency: 'once' }], month, today)).toHaveLength(0)
  })
  it('оплата относится только к выбранному месяцу, не создаёт транзакцию', () => {
    const paid: Payment = { ...payment, paid: { '2026-10': { date: localDate(today), transactionId: 'existing-expense' } } }
    const october = paymentOccurrences([paid], month, today)
    expect(october[0].status).toBe('paid'); expect(paymentTotals(october)).toEqual({ total: 123456, paid: 123456, remaining: 0, overdue: 0 })
    expect(paymentOccurrences([paid], new Date(2026, 10, 1), today)[0].status).toBe('expected')
    expect(paymentOccurrences([payment], new Date(2026, 8, 1), today)[0].status).toBe('overdue')
  })
})
describe('результат примерного импорта', () => {
  it('разрешает одинаковые дату/сумму при разных ID', () => {
    const a = row('a'), b = row('b')
    expect(importOutcome([{ transaction: b, ambiguous: false, choice: 'include' }], new Set([a.id])).accepted).toBe(1)
  })
  it('сводка соответствует исключению/спорным/дублям и учитывает правку категории', () => {
    const rows = createImportExample('kaspi', month, [row('existing')])
    rows[0].choice = 'exclude'; rows[1].transaction.category = 'Другое'
    const result = importOutcome(rows, new Set(['existing']))
    expect(result).toMatchObject({ accepted: 2, excluded: 1, review: 1, duplicates: 1 })
    expect(result.transactions[0].category).toBe('Другое')
    expect(result.accepted + result.excluded + result.review + result.duplicates).toBe(rows.length)
    expect(importOutcome(rows, new Set(['existing', ...result.transactions.map(item => item.id)])).accepted).toBe(0)
  })
  it('подтверждение спорной строки меняет фактический итог', () => {
    const rows = createImportExample('freedom', month, [])
    const review = rows.find(row => row.ambiguous)!
    review.choice = 'include'
    expect(importOutcome(rows, new Set()).accepted).toBe(4)
  })
})
