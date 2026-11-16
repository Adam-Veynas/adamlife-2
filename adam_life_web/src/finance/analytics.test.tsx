import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { analyticsRanges, analyticsRows, categorySlices, comparisonText, depositGroups, drilldownRows, flowPoints, sliceColor, validRange, type AnalyticsFilter } from './analytics'
import { AnalyticsCategories, AnalyticsDeposits, AnalyticsFlow, FinancialAnalytics } from './FinancialAnalytics'
import { filterOperations, totals, type Account, type Category, type Operation, type Snapshot } from './client'

const account: Account = { id: 'card', name: 'Карта', kind: 'bank', bank_code: 'Банк', currency: 'KZT', opening_date: '2026-01-01', opening_balance_minor: '5000', balance_minor: '10000', archived: false, version: 1 }
const deposit: Account = { ...account, id: 'deposit', name: 'Резерв', kind: 'deposit', annual_rate: '100', balance_minor: '90000' }
const categories: Category[] = [{ id: 'food', name: 'Продукты', kind: 'expense', archived: false, version: 1 }, { id: 'interest', name: 'Проценты', kind: 'income', archived: false, version: 1 }]
const operation: Operation = { id: '1', kind: 'expense', account_id: 'card', destination_account_id: null, category_id: 'food', currency: 'KZT', amount_minor: '1001', occurred_on: '2026-11-05', comment: '', version: 1 }
const rows: Operation[] = [operation,
  { ...operation, id: '2', kind: 'income', account_id: 'deposit', category_id: 'interest', amount_minor: '505' },
  { ...operation, id: '3', kind: 'transfer', destination_account_id: 'deposit', category_id: null, amount_minor: '999999' },
  { ...operation, id: '4', kind: 'transfer', account_id: 'deposit', destination_account_id: 'card', category_id: null, amount_minor: '500' },
  { ...operation, id: '5', currency: 'USD', amount_minor: '100000' },
  { ...operation, id: '6', category_id: 'missing', amount_minor: '202' },
  { ...operation, id: '7', category_id: null, amount_minor: '303' },
  { ...operation, id: '8', occurred_on: '2026-10-05', amount_minor: '400' },
]
const filter: AnalyticsFilter = { currency: 'KZT', accounts: [], from: '2026-11-01', to: '2026-11-11' }
const emptyBalances = { total_minor: '0', current_minor: '0', deposit_minor: '0' }
const snapshot: Snapshot = { as_of: '2026-11-11', accounts: [account, deposit], categories, operations: rows, balances: { KZT: emptyBalances, USD: emptyBalances, EUR: emptyBalances } }
const noop = () => {}

describe('calendar periods', () => {
  it('compares an incomplete month with the matching part of the previous month', () => {
    expect(analyticsRanges('month', '2026-11-11', filter)).toEqual({ current: { from: '2026-11-01', to: '2026-11-11' }, previous: { from: '2026-10-01', to: '2026-10-11' } })
  })
  it('uses complete calendar months for last month, including leap February', () => {
    expect(analyticsRanges('previous', '2024-03-19', filter)).toEqual({ current: { from: '2024-02-01', to: '2024-02-29' }, previous: { from: '2024-01-01', to: '2024-01-31' } })
  })
  it('clamps previous month days and compares full months at month end', () => {
    expect(analyticsRanges('month', '2024-03-30', filter)?.previous.to).toBe('2024-02-29')
    expect(analyticsRanges('month', '2026-02-28', filter)?.previous.to).toBe('2026-01-31')
  })
  it.each([['3', '2026-09-01', '2026-06-01', '2026-08-11'], ['6', '2026-06-01', '2025-12-01', '2026-05-11'], ['12', '2025-12-01', '2024-12-01', '2025-11-11']] as const)('uses calendar boundaries for %s months', (period, from, previousFrom, previousTo) => {
    expect(analyticsRanges(period, '2026-11-11', filter)).toEqual({ current: { from, to: '2026-11-11' }, previous: { from: previousFrom, to: previousTo } })
  })
  it('compares custom dates with the immediately preceding equal number of days', () => {
    expect(analyticsRanges('custom', '2024-03-01', { from: '2024-02-28', to: '2024-03-01' })?.previous).toEqual({ from: '2024-02-25', to: '2024-02-27' })
  })
  it.each([{ from: '', to: '2026-11-01' }, { from: '2026-11-02', to: '2026-11-01' }, { from: '2026-02-30', to: '2026-03-01' }])('rejects invalid dates without chart arithmetic', range => {
    expect(validRange(range)).toBe(false); expect(analyticsRanges('custom', snapshot.as_of, range)).toBeNull(); expect(flowPoints(rows, range)).toEqual([])
  })
})

describe('exact analytics of the existing ledger', () => {
  it.each([[], ['card'], ['deposit'], ['card', 'deposit']].map(accounts => ({ accounts })))('never counts transfers, even for only one side: $accounts', ({ accounts }) => {
    expect(analyticsRows(rows, { ...filter, accounts }).every(row => row.kind !== 'transfer')).toBe(true)
  })
  it('counts recorded interest, excludes opening balance and hypothetical yield, isolates currency', () => {
    expect(totals(analyticsRows(rows, filter))).toEqual({ income: 505n, expense: 1506n, net: -1001n })
    expect(totals(analyticsRows(rows, { ...filter, accounts: ['deposit'] }))).toEqual({ income: 505n, expense: 0n, net: 505n })
    expect(totals(analyticsRows(rows, { ...filter, currency: 'USD' })).expense).toBe(100000n)
  })
  it('keeps precision above the safe integer limit and does not mutate operations', () => {
    const amounts = [operation, { ...operation, id: 'huge', amount_minor: '9000000000000000' }, { ...operation, id: 'huge2', amount_minor: '9000000000000000' }]
    const copy = JSON.stringify(amounts)
    const current = analyticsRows(amounts, filter)
    expect(totals(current).expense).toBe(18000000000001001n)
    expect(categorySlices(current, [], categories, 'expense')[0].amount).toBe(18000000000001001n)
    expect(flowPoints(current, filter).reduce((sum, point) => sum + point.expense, 0n)).toBe(18000000000001001n)
    expect(JSON.stringify(amounts)).toBe(copy)
  })
  it('retains missing and unassigned categories with their full amounts', () => {
    const items = categorySlices(analyticsRows(rows, filter), [], categories, 'expense')
    expect(items.reduce((sum, item) => sum + item.amount, 0n)).toBe(1506n)
    expect(items.filter(item => item.name === 'Без категории')).toHaveLength(2)
    expect(items.reduce((sum, item) => sum + item.share, 0)).toBeCloseTo(1, 5)
  })
  it('uses identical filters for category history including several accounts and null categories', () => {
    for (const category of ['food', 'missing', null]) {
      const drill = { ...filter, accounts: ['card', 'deposit'], kind: 'expense' as const, category }
      const history = filterOperations(rows, { ...drill, account: '', category: category ?? '', categoryUnassigned: category === null })
      expect(drilldownRows(rows, drill)).toEqual(history)
      const expected = categorySlices(analyticsRows(rows, filter), [], categories, 'expense').find(item => item.id === category)!.amount
      expect(totals(history).expense).toBe(expected)
    }
  })
  it('updates sums and categories from edited/deleted operations without another data source', () => {
    const edited = rows.filter(row => row.id !== '7').map(row => row.id === '1' ? { ...row, category_id: 'new', amount_minor: '5000' } : row)
    const current = analyticsRows(edited, filter)
    expect(totals(current).expense).toBe(5202n)
    expect(categorySlices(current, [], categories, 'expense').find(item => item.id === 'new')?.amount).toBe(5000n)
    expect(categorySlices(current, [], categories, 'expense').some(item => item.id === 'food')).toBe(false)
  })
  it('does not depend on the operation origin', () => {
    const imported = rows.map(row => ({ ...row, source: 'bank_import' }))
    expect(analyticsRows(imported, filter).map(row => row.id)).toEqual(analyticsRows(rows, filter).map(row => row.id))
    expect(totals(analyticsRows(imported, filter))).toEqual(totals(analyticsRows(rows, filter)))
  })
  it('uses neutral zero-base comparison and supports disappearing categories', () => {
    expect(comparisonText(100n, 0n)).toBe('Нет базы для сравнения')
    expect(comparisonText(0n, 0n)).not.toMatch(/NaN|Infinity|%/)
    expect(comparisonText(0n, 400n)).toBe('−100% к предыдущему периоду')
    expect(comparisonText(600n, 400n)).toBe('+50% к предыдущему периоду')
    expect(categorySlices([], [operation], categories, 'expense')[0]).toMatchObject({ amount: 0n, previous: 1001n, share: 0 })
  })
  it('keeps category comparison restricted to the same selected account and dates', () => {
    const current = analyticsRows(rows, { ...filter, accounts: ['deposit'] })
    const previous = analyticsRows(rows, { ...filter, accounts: ['deposit'], from: '2026-10-01', to: '2026-10-11' })
    expect(categorySlices(current, previous, categories, 'expense')).toEqual([])
  })
  it('keeps colors stable when categories are renamed or reordered', () => {
    expect(categorySlices([operation], [], [{ ...categories[0], name: 'Еда' }], 'expense')[0].color).toBe(sliceColor('food'))
  })
})

describe('flow and current deposits', () => {
  it('fills daily gaps with zeros, including leap day', () => {
    const points = flowPoints([{ ...operation, occurred_on: '2024-02-29' }], { from: '2024-02-27', to: '2024-02-29' })
    expect(points.map(p => p.expense)).toEqual([0n, 0n, 1001n])
  })
  it('groups multiple months, retains empty months and excludes transfers', () => {
    const points = flowPoints(analyticsRows(rows, { ...filter, from: '2026-09-01' }), { from: '2026-09-01', to: '2026-11-11' })
    expect(points.map(p => p.expense)).toEqual([0n, 400n, 1506n]); expect(points.map(p => p.income)).toEqual([0n, 0n, 505n])
  })
  it('groups current deposits by currency, includes archived balances and honors account selection', () => {
    const accounts = [account, deposit, { ...deposit, id: 'usd', currency: 'USD' as const, balance_minor: '12345', archived: true }]
    expect(depositGroups(accounts, []).map(g => [g.currency, g.total])).toEqual([['KZT', 90000n], ['USD', 12345n]])
    expect(depositGroups(accounts, ['card'])).toEqual([])
    expect(depositGroups(accounts, ['deposit']).map(g => g.total)).toEqual([90000n])
  })
})

describe('analytics components', () => {
  it.each(['bars', 'donut'] as const)('renders %s with exact totals, category links and shared selections', mode => {
    const items = categorySlices(analyticsRows(rows, filter), [], categories, 'expense')
    const html = renderToStaticMarkup(<AnalyticsCategories items={items} total={1506n} currency="KZT" kind="expense" mode={mode} onMode={noop} onKind={noop} onCategory={noop} />)
    expect(html).toContain('15,06'); expect(html).toContain('10,01'); expect(html).toContain('Продукты')
    expect(html).toContain(`aria-pressed="true" class="selected">${mode === 'bars' ? 'Столбцы' : 'Круг'}`)
    expect(html).not.toMatch(/NaN|Infinity/)
    if (mode === 'donut') { expect(html).toContain('Всего расходов'); expect(html).toContain('role="button"') }
  })
  it('does not render an invalid empty donut', () => {
    const html = renderToStaticMarkup(<AnalyticsCategories items={[]} total={0n} currency="EUR" kind="income" mode="donut" onMode={noop} onKind={noop} onCategory={noop} />)
    expect(html).toContain('Доходов за выбранный период нет'); expect(html).not.toContain('<svg')
  })
  it('provides exact chart values and direct accessible interaction for both types', () => {
    const html = renderToStaticMarkup(<AnalyticsFlow points={[{ date: '2026-11-05', label: '5 ноября', income: 101n, expense: 202n }]} currency="USD" />)
    expect(html).toContain('1,01 $'); expect(html).toContain('2,02 $'); expect(html).toContain('role="slider"'); expect(html).not.toContain('type="range"')
  })
  it('shows current deposit totals as separate currencies, not income or forecasts', () => {
    const html = renderToStaticMarkup(<AnalyticsDeposits accounts={[deposit, { ...deposit, id: 'eur', currency: 'EUR' }]} selected={[]} onOpen={noop} />)
    expect(html).toContain('900 ₸'); expect(html).toContain('900 €'); expect(html).toContain('не доходы за период'); expect(html).not.toMatch(/Прогноз|Цели|Планы/)
  })
  it('places summaries, flow, categories and deposits in requested order', () => {
    const html = renderToStaticMarkup(<FinancialAnalytics data={snapshot} currency="KZT" onCategory={noop} onDeposit={noop} />)
    const order = ['analytics-filters', 'analytics-summary', 'analytics-flow', 'analytics-categories', 'analytics-deposits'].map(text => html.indexOf(text))
    expect(order.every(index => index >= 0)).toBe(true); expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(html).toContain('Сравнение:'); expect(html).toContain('11.10.2026')
  })
})
