import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { totals, filterOperations, type Operation, type Snapshot } from './client'
import { analyticsRows, categorySlices, flowPoints, drilldownRows, comparisonText } from './analytics'
import { OperationRows } from './OperationRows'
import { KaspiImport } from './KaspiImport'
import { OperationEditor } from './Editors'
import { AnalyticsCategories, AnalyticsFlow } from './FinancialAnalytics'

const base: Operation = { id: 'original', kind: 'expense', account_id: 'a', destination_account_id: null, currency: 'KZT', category_id: 'food', occurred_on: '2026-01-05', amount_minor: '10001', comment: 'Тест', version: 1 }
const refund: Operation = { ...base, id: 'refund', kind: 'income', adjustment_type: 'refund', amount_minor: '42', related_transaction_id: 'original', expense_correction_minor: '42', correction_category_id: 'food' }
const transfer: Operation = { ...base, id: 'transfer', kind: 'transfer', destination_account_id: 'b', category_id: null, amount_minor: '100000' }
const zero = { total_minor: '0', current_minor: '0', deposit_minor: '0' }
const data: Snapshot = { accounts: [], categories: [], operations: [base, refund, transfer], as_of: '2026-01-10', balances: { KZT: zero, USD: zero, EUR: zero } }
const filter = { currency: 'KZT' as const, accounts: ['a'], from: '2026-01-01', to: '2026-01-10' }
const noop = () => {}

describe('Kaspi financial integration', () => {
  it('keeps refunds out of earnings and transfers out of both totals', () => {
    expect(totals(data.operations)).toEqual({ income: 0n, expense: 9959n, net: -9959n })
    expect(analyticsRows(data.operations, filter)).toEqual([base, refund])
  })
  it('uses the same corrected rows for chart, bars, donut and category drilldown', () => {
    const rows = analyticsRows(data.operations, filter)
    expect(categorySlices(rows, [], [], 'expense')[0].amount).toBe(9959n)
    expect(flowPoints(rows, filter).reduce((sum, p) => sum + p.income, 0n)).toBe(0n)
    expect(filterOperations(data.operations, { ...filter, account: 'a', category: '', kind: 'income' })).toEqual([])
    expect(filterOperations(data.operations, { ...filter, account: 'a', category: '', kind: 'adjustment' })).toEqual([refund])
  })
  it('labels the real correction instead of ordinary earnings', () => {
    const html = renderToStaticMarkup(<OperationRows items={[refund]} data={data} onSelect={noop} />)
    expect(html).toContain('Возврат покупки'); expect(html).toContain('+0,42'); expect(html).not.toContain('>Доход<')
  })
  it('offers upload, history and user rules with confirmation before saving', () => {
    const html = renderToStaticMarkup(<KaspiImport data={data} csrf="synthetic" onChanged={async () => {}} onClose={noop} onUnauthorized={noop} />)
    expect(html).toContain('type="file"'); expect(html).toContain('application/pdf'); expect(html).toContain('История'); expect(html).toContain('Правила')
    expect(html).toContain('только после подтверждения'); expect(html).not.toContain('synthetic')
  })
  it('preserves a correction visibly when opening the existing operation editor', () => {
    const html = renderToStaticMarkup(<OperationEditor item={refund} data={data} onSave={async () => {}} onClose={noop} />)
    expect(html).toContain('Корректировка / возврат средств'); expect(html).toContain('checked=""')
  })
})


describe('Net expense corrections', () => {
  it('uses the actual return period without changing the purchase period', () => {
    const february = { ...refund, occurred_on: '2026-02-05' }
    const rows = [base, february]
    expect(totals(analyticsRows(rows, filter)).expense).toBe(10001n)
    const period = { ...filter, from: '2026-02-01', to: '2026-02-28' }
    const selected = analyticsRows(rows, period)
    expect(totals(selected)).toEqual({ income: 0n, expense: -42n, net: 42n })
    expect(flowPoints(selected, period).reduce((n, p) => n + p.expense, 0n)).toBe(-42n)
    expect(drilldownRows(rows, { ...period, kind: 'expense', category: 'food' })).toEqual([february])
    expect(filterOperations(rows, { ...period, kind: 'expense', category: 'food', account: 'a' })).toEqual([february])
  })
  it('keeps full and partial refunds exact, including large minor units', () => {
    const purchase = { ...base, amount_minor: '8999999999999999' }
    const part = { ...refund, amount_minor: '8999999999999957', expense_correction_minor: '8999999999999957' }
    expect(totals([purchase, part]).expense).toBe(42n)
    expect(totals([purchase, part, refund]).expense).toBe(0n)
  })
  it('keeps currency and account filters consistent for corrections', () => {
    expect(analyticsRows([refund, { ...refund, id: 'usd', currency: 'USD' }, { ...refund, id: 'other', account_id: 'b' }], filter)).toEqual([refund])
    expect(filterOperations([refund], { ...filter, account: 'b', kind: 'expense', category: '' })).toEqual([])
  })
  it('does not count unknown refunds or FX as ordinary income or expenses', () => {
    const unknown = { ...refund, expense_correction_minor: '0', correction_category_id: null, related_transaction_id: null, adjustment_pending: true }
    const fx = { ...unknown, adjustment_type: 'fx' as const }
    expect(totals([unknown, fx, transfer])).toEqual({ income: 0n, expense: 0n, net: 0n })
    expect(analyticsRows([unknown, fx], filter)).toEqual([])
    const html = renderToStaticMarkup(<OperationRows items={[unknown]} data={data} onSelect={noop} />)
    expect(html).toContain('требуется проверка')
  })
  it('shows negative category totals separately with bounded donut shares', () => {
    const rows = [refund, { ...base, id: 'positive', category_id: 'transport', amount_minor: '100' }]
    const items = categorySlices(rows, [], [], 'expense')
    expect(items.reduce((sum, item) => sum + item.amount, 0n)).toBe(totals(rows).expense)
    expect(items.find(item => item.id === 'food')?.share).toBe(0)
    expect(items.find(item => item.id === 'transport')?.share).toBe(1)
    for (const mode of ['bars', 'donut'] as const) {
      const html = renderToStaticMarkup(<AnalyticsCategories items={items} total={58n} currency="KZT" kind="expense" mode={mode} onMode={noop} onKind={noop} onCategory={noop} />)
      expect(html).toContain('0,58'); expect(html).toContain('−0,42')
      expect(html).toContain('Возвраты за период'); expect(html).not.toContain('NaN'); expect(html).not.toContain('width:-')
      expect(html).not.toContain('stroke-dasharray="-')
    }
    expect(comparisonText(100n, -42n)).toBe('Нет базы для сравнения')
  })
  it('renders a refund-only period without negative donut sectors or clipped flow', () => {
    const items = categorySlices([refund], [], [], 'expense')
    const html = renderToStaticMarkup(<AnalyticsCategories items={items} total={-42n} currency="KZT" kind="expense" mode="donut" onMode={noop} onKind={noop} onCategory={noop} />)
    expect(html).toContain('−0,42'); expect(html).not.toContain('stroke-dasharray=')
    const flow = renderToStaticMarkup(<AnalyticsFlow points={[{ date: '2026-01-05', label: 'Тест', income: 0n, expense: -42n }]} currency="KZT" />)
    expect(flow).not.toContain('NaN'); expect(flow).not.toContain('Infinity'); expect(flow).toContain('cy="177"')
  })
  it('allows resolving or detaching a pending correction in the existing editor', () => {
    const html = renderToStaticMarkup(<OperationEditor item={{ ...refund, related_transaction_id: null }} data={data} onSave={async () => {}} onClose={noop} />)
    expect(html).toContain('Исходная операция'); expect(html).toContain('Не подтверждена'); expect(html).toContain('value="original"')
  })
})

 it('shows current exact balances and currencies in both transfer selectors', () => {
   const account = { id: 'a', name: 'From', kind: 'bank' as const, bank_code: null, currency: 'KZT' as const, opening_date: '2026-01-01', opening_balance_minor: '0', balance_minor: '12345678', archived: false, version: 1 }
   const html = renderToStaticMarkup(<OperationEditor item={transfer} data={{ ...data, accounts: [account, { ...account, id: 'b', name: 'To', balance_minor: '12345' }] }} onSave={async () => {}} onClose={noop} />)
   expect(html).toContain('123 456,78 ₸ · KZT'); expect(html).toContain('123,45 ₸ · KZT')
 })
