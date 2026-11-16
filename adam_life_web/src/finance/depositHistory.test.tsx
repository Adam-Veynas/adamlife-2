import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BalanceHistoryChart } from '../components/Charts'
import { chartPointIndex } from '../domain/analytics'
import { formatMoney, type Account, type Operation } from './client'
import { compareDeposits, depositHistory, depositTerm } from './depositHistory'

const account: Account = { id: 'd', kind: 'deposit', name: 'Депозит', bank_code: 'bank', currency: 'KZT', opening_date: '2025-01-01', opening_balance_minor: '10000', balance_minor: '13000', archived: false, version: 1 }
const op = (date: string, kind: Operation['kind'], amount: string, extra: Partial<Operation> = {}): Operation => ({ id: date, kind, account_id: 'd', destination_account_id: null, category_id: kind === 'transfer' ? null : 'category', currency: 'KZT', amount_minor: amount, occurred_on: date, comment: '', version: 1, ...extra })
const rows = [op('2026-08-31', 'income', '1000'), op('2026-09-01', 'transfer', '5000', { account_id: 'card', destination_account_id: 'd' }), op('2026-09-30', 'expense', '500'), op('2026-11-06', 'transfer', '3000', { destination_account_id: 'card' }), op('2026-11-06', 'income', '500')]

describe('actual deposit balance chart', () => {
  it('carries opening and earlier transactions forward, includes all real movements', () => {
    const h = depositHistory(account, [...rows].reverse(), '2026-11-06', 3)!
    expect(h.start).toBe('2026-09-01')
    expect(h.baseline).toBe(11000n)
    expect(h.points.map(p => [p.date, p.amount])).toEqual([['2026-09-30', 15500n], ['2026-10-31', 15500n], ['2026-11-06', 13000n]])
    expect(h.change).toBe(2000n)
    expect([h.added, h.withdrawn]).toEqual([5000n, 3000n])
  })
  it.each([3, 6, 12] as const)('creates %i monthly points with directly selectable positions', months => {
    const h = depositHistory(account, [], '2026-11-06', months)!
    expect(h.points).toHaveLength(months)
    expect(h.points.every(p => p.amount === 10000n)).toBe(true)
    h.points.forEach((_, i) => expect(chartPointIndex(12 + i / (months - 1) * 560, months)).toBe(i))
  })
  it('handles new and future account opening dates without inventing earlier money', () => {
    expect(depositHistory({ ...account, opening_date: '2026-10-15' }, [], '2026-11-06', 3)!.points.map(p => p.amount)).toEqual([10000n, 10000n])
    expect(depositHistory({ ...account, opening_date: '2026-09-01' }, [], '2026-11-06', 3)!.change).toBe(10000n)
    expect(depositHistory({ ...account, opening_date: '2027-01-01' }, [], '2026-11-06', 3)!.points).toEqual([])
  })
  it('ignores future, other-account, other-currency and pre-opening entries', () => {
    const excluded = [op('2026-11-07', 'income', '100'), op('2024-12-31', 'income', '100'), op('2026-10-01', 'income', '100', { currency: 'USD' }), op('2026-10-01', 'income', '100', { account_id: 'other' })]
    expect(depositHistory(account, excluded, '2026-11-06', 3)!.points.every(p => p.amount === 10000n)).toBe(true)
  })
  it('recomputes for edited/deleted entries and changed opening balance', () => {
    expect(depositHistory(account, rows.filter(r => r.kind !== 'expense'), '2026-11-06', 3)!.points.at(-1)!.amount).toBe(13500n)
    expect(depositHistory(account, rows.map(r => r.kind === 'expense' ? { ...r, amount_minor: '1000' } : r), '2026-11-06', 3)!.points.at(-1)!.amount).toBe(12500n)
    expect(depositHistory({ ...account, opening_balance_minor: '0' }, rows, '2026-11-06', 3)!.points.at(-1)!.amount).toBe(3000n)
  })
  it('keeps BigInt precision and includes negative balances without forecast interest', () => {
    const large = { ...account, opening_balance_minor: '9007199254740993', annual_rate: '20', deposit_ends_on: '2028-01-01' }
    const h = depositHistory(large, [op('2026-10-01', 'income', '1')], '2026-11-06', 3)!
    expect(h.points.at(-1)!.amount).toBe(9007199254740994n)
    expect(depositHistory(account, [op('2026-09-01', 'expense', '20000')], '2026-11-06', 3)!.points.at(-1)!.amount).toBe(-10000n)
    const html = renderToStaticMarkup(<BalanceHistoryChart points={h.points} format={v => formatMoney(v, 'KZT')} />)
    expect(html).not.toMatch(/NaN|Infinity/)
    expect(html).toContain('role="slider"')
    expect(html).toContain('aria-valuemax="2"')
    expect(html).not.toContain('type="range"')
  })
  it('crosses leap February and year boundaries correctly', () => {
    expect(depositHistory(account, [], '2028-03-01', 3)!.points.map(p => p.date)).toEqual(['2028-01-31', '2028-02-29', '2028-03-01'])
    expect(depositHistory(account, [], '2026-01-01', 3)!.start).toBe('2025-11-01')
    expect(depositHistory(account, [], 'invalid', 3)).toBeNull()
  })
})

describe('deposit maturity', () => {
  it.each([
    ['2026-12-07', 31, 'Активен'], ['2026-12-06', 30, 'Скоро заканчивается'],
    ['2026-11-07', 1, 'Скоро заканчивается'], ['2026-11-06', 0, 'Скоро заканчивается'],
    ['2026-11-05', -1, 'Срок истёк'],
  ])('classifies ending %s', (end, days, status) => expect(depositTerm(end as string, '2026-11-06')).toEqual({ end, days, status }))
  it('has no countdown without a valid end date; counts leap calendar days', () => {
    expect(depositTerm(null, '2026-11-06')).toBeNull()
    expect(depositTerm('2026-02-30', '2026-11-06')).toBeNull()
    expect(depositTerm('2028-03-01', '2028-02-28')!.days).toBe(2)
  })
})

describe('deposit comparison', () => {
  it('hides zero or single-deposit comparisons even with other account kinds', () => {
    expect(compareDeposits([], [], '2026-11-06', 3)).toEqual([])
    expect(compareDeposits([account, { ...account, id: 'card', kind: 'bank' }], [], '2026-11-06', 3)).toEqual([])
  })
  it('groups any number of deposits by currency and retains names/banks/archives', () => {
    const accounts = Array.from({ length: 45 }, (_, i) => ({ ...account, id: String(i), currency: (['KZT', 'USD', 'EUR'] as const)[i % 3], archived: i === 0 }))
    const groups = compareDeposits(accounts, [], '2026-11-06', 12)
    expect(groups.map(g => [g.currency, g.rows.length])).toEqual([['KZT', 15], ['USD', 15], ['EUR', 15]])
    expect(groups[0].rows[0].account).toEqual(accounts[0])
  })
  it('compares selected-period changes separately from lifetime transfers and updates both sides', () => {
    const second = { ...account, id: 'second', opening_balance_minor: '0', balance_minor: '4000' }
    const transfer = op('2026-09-01', 'transfer', '4000', { destination_account_id: 'second' })
    const earlier = op('2026-06-01', 'transfer', '1000', { account_id: 'card', destination_account_id: 'd' })
    const compared = compareDeposits([account, second], [transfer, earlier], '2026-11-06', 3)[0].rows
    expect(compared[0].history).toMatchObject({ added: 1000n, withdrawn: 4000n, change: -4000n })
    expect(compared[1].history).toMatchObject({ added: 4000n, withdrawn: 0n, change: 4000n })
    expect(compareDeposits([account, second], [earlier], '2026-11-06', 3)[0].rows.every(r => r.history!.change === 0n)).toBe(true)
    expect(compareDeposits([account, second], [transfer, earlier], '2026-11-06', 6)[0].rows[0].history!.change).toBe(-3000n)
  })
})
