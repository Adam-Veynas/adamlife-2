import { describe, expect, it } from 'vitest'
import { addCalendarMonths, depositForecast, depositMovements } from './depositCalculations'
import { totals, type Account, type Category, type Operation } from './client'

const account: Account = { id: 'deposit', name: 'Депозит', bank_code: 'bank', kind: 'deposit', currency: 'KZT', opening_date: '2026-01-01', opening_balance_minor: '10000', balance_minor: '10000000', version: 1, archived: false, deposit_type: 'term', annual_rate: '10.0000', deposit_ends_on: '2027-01-01' }
const categories: Category[] = [{ id: 'interest', name: 'Проценты по депозиту', kind: 'income', archived: false, version: 1 }, { id: 'other', name: 'Другое', kind: 'income', archived: false, version: 1 }]
const op = (overrides: Partial<Operation>): Operation => ({ id: 'op', kind: 'transfer', account_id: 'card', destination_account_id: 'deposit', category_id: null, currency: 'KZT', amount_minor: '1000', occurred_on: '2026-02-01', comment: '', version: 1, ...overrides })

describe('simple deposit forecast', () => {
  it('computes one year without changing principal, metadata or ledger', () => {
    const original = JSON.stringify(account)
    expect(depositForecast(account, '2026-01-01', 3)).toEqual({ available: true, end: '2027-01-01', days: 365, income: 1000000n, total: 11000000n, ended: false })
    expect(JSON.stringify(account)).toBe(original)
  })
  it('uses actual leap-year days and a fixed 365-day denominator', () => {
    const result = depositForecast({ ...account, deposit_ends_on: '2025-01-01', balance_minor: '3650000', annual_rate: '10' }, '2024-01-01', 3)
    expect(result).toMatchObject({ days: 366, income: 366000n })
  })
  it('clamps calendar months at month-end, independent of time zones', () => {
    expect(addCalendarMonths('2026-01-31', 3)).toBe('2026-04-30')
    expect(addCalendarMonths('2023-08-31', 6)).toBe('2024-02-29')
    expect(addCalendarMonths('2024-02-29', 12)).toBe('2025-02-28')
    expect(addCalendarMonths('2026-02-30', 3)).toBeNull()
  })
  it.each([3, 6, 12] as const)('uses the selected %i months for an open-ended savings deposit', months => {
    expect(depositForecast({ ...account, deposit_type: 'savings', deposit_ends_on: null }, '2026-01-01', months)).toMatchObject({ available: true, end: addCalendarMonths('2026-01-01', months) })
  })
  it('uses the supplied end date even for a savings deposit', () => {
    expect(depositForecast({ ...account, deposit_type: 'savings' }, '2026-01-01', 3)).toMatchObject({ days: 365 })
  })
  it.each(['2026-01-01', '2025-12-31'])('does not forecast future interest for end date %s', end => {
    expect(depositForecast({ ...account, deposit_ends_on: end }, '2026-01-01', 3)).toMatchObject({ days: 0, income: 0n, total: 10000000n, ended: true })
  })
  it('handles zero rates/balances and rejects unavailable inputs', () => {
    expect(depositForecast({ ...account, annual_rate: '0' }, '2026-01-01', 3)).toMatchObject({ income: 0n })
    expect(depositForecast({ ...account, balance_minor: '0' }, '2026-01-01', 3)).toMatchObject({ total: 0n })
    for (const patch of [{ annual_rate: null }, { annual_rate: 'NaN' }, { deposit_type: null }, { deposit_ends_on: null }, { deposit_ends_on: '2026-02-30' }, { balance_minor: '-1' }]) {
      expect(depositForecast({ ...account, ...patch }, '2026-01-01', 3).available).toBe(false)
    }
    expect(depositForecast(account, '', 3).available).toBe(false)
  })
  it('keeps large amounts exact and rounds only the final minor unit', () => {
    const large = 9007199254740993n
    expect(depositForecast({ ...account, balance_minor: large.toString(), annual_rate: '100' }, '2026-01-01', 3)).toMatchObject({ income: large, total: large * 2n })
    expect(depositForecast({ ...account, balance_minor: '1', annual_rate: '50' }, '2026-01-01', 3)).toMatchObject({ income: 1n })
    expect(depositForecast({ ...account, balance_minor: '365000000', annual_rate: '0.0001', deposit_ends_on: '2026-01-02' }, '2026-01-01', 3)).toMatchObject({ income: 1n })
  })
})

describe('deposit movements from the current ledger snapshot', () => {
  const incoming = op({ id: 'in', amount_minor: '10000000' })
  const outgoing = op({ id: 'out', account_id: 'deposit', destination_account_id: 'card', amount_minor: '3000000' })
  const interest = op({ id: 'interest', kind: 'income', account_id: 'deposit', destination_account_id: null, category_id: 'interest', amount_minor: '12345' })
  it('counts transfer sides once and only explicitly categorized income as interest', () => {
    const operations = [incoming, outgoing, interest, op({ kind: 'income', account_id: 'deposit', category_id: 'other', amount_minor: '999', comment: 'Проценты по депозиту' }), op({ account_id: 'other-deposit', destination_account_id: 'elsewhere' })]
    expect(depositMovements(account, operations, categories, '2026-11-06')).toEqual({ opening: 10000n, added: 10000000n, withdrawn: 3000000n, interest: 12345n, current: 10000000n })
    expect(totals([incoming, outgoing])).toEqual({ income: 0n, expense: 0n, net: 0n })
  })
  it('excludes future, pre-boundary, other-account and other-currency operations', () => {
    const rows = [op({ occurred_on: '2027-01-01' }), op({ occurred_on: '2025-12-31' }), { ...interest, account_id: 'other-deposit' }, { ...interest, currency: 'USD' as const }]
    expect(depositMovements(account, rows, categories, '2026-11-06')).toMatchObject({ added: 0n, withdrawn: 0n, interest: 0n })
  })
  it('recomputes after edit, recategorization and deletion without cached totals', () => {
    expect(depositMovements(account, [{ ...incoming, amount_minor: '500' }, outgoing, { ...interest, category_id: 'other' }], categories, '2026-11-06')).toMatchObject({ added: 500n, withdrawn: 3000000n, interest: 0n })
    expect(depositMovements({ ...account, balance_minor: '10000' }, [], categories, '2026-11-06')).toMatchObject({ added: 0n, withdrawn: 0n, interest: 0n, current: 10000n })
    expect(depositMovements(account, [{ ...incoming, destination_account_id: 'another' }], categories, '2026-11-06').added).toBe(0n)
  })
  it('keeps archived interest categories and responds to a renamed category', () => {
    expect(depositMovements(account, [interest], [{ ...categories[0], archived: true }], '2026-11-06').interest).toBe(12345n)
    expect(depositMovements(account, [interest], [{ ...categories[0], name: 'Другой доход' }], '2026-11-06').interest).toBe(0n)
  })
})
