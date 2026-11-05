import { afterEach, describe, expect, it, vi } from 'vitest'
import { amountText, filterOperations, financeRequest, formatMoney, movement, parseMinor, totals, type Operation } from './client'

const row = (kind: Operation['kind'], amount = '10001'): Operation => ({ id: kind, kind, account_id: 'a', destination_account_id: kind === 'transfer' ? 'b' : null, amount_minor: amount, currency: 'KZT', category_id: kind === 'transfer' ? null : 'c', occurred_on: '2026-11-05', comment: '', version: 1 })
afterEach(() => vi.unstubAllGlobals())
describe('real finance arithmetic and transport', () => {
  it('uses exact tiyn including values beyond JS integer totals', () => {
    expect(parseMinor('90 000 000 000 000,00')).toBe('9000000000000000')
    expect(amountText('-101')).toBe('-1.01')
    expect(parseMinor('-1,01', true)).toBe('-101')
    expect(formatMoney('9000000000000001', 'KZT').replace(/\s/g, '')).toBe('90000000000000,01₸')
    expect(totals([row('income', '9000000000000000'), row('income', '2')]).income).toBe(9000000000000002n)
  })
  it.each(['0', '-1', 'NaN', 'Infinity', '1.001', '1e3', '90000000000000.01'])('rejects invalid positive money %s', value => expect(() => parseMinor(value)).toThrow())
  it('excludes transfers from income and expense but shows both account movements', () => {
    const transfer = row('transfer')
    expect(totals([row('income'), row('expense', '1'), transfer])).toEqual({ income: 10001n, expense: 1n, net: 10000n })
    expect(movement(transfer, 'a')).toMatch(/^−/)
    expect(movement(transfer, 'b')).toMatch(/^\+/)
    expect(movement(transfer, '')).not.toMatch(/^[−+]/)
  })
  it('combines account, currency, period, type and category filters', () => {
    const rows = [row('transfer'), row('income'), { ...row('expense'), currency: 'EUR' as const }]
    const filter = { currency: 'KZT' as const, account: 'b', kind: '', category: '', from: '2026-11-01', to: '2026-11-30' }
    expect(filterOperations(rows, filter)).toEqual([rows[0]])
    expect(filterOperations(rows, { ...filter, account: 'a', category: 'c', kind: 'income' })).toEqual([rows[1]])
    expect(filterOperations(rows, { ...filter, to: '2026-11-04' })).toEqual([])
  })
  it('sends session cookies and CSRF, keeps integer strings and never writes browser storage', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('must not persist finance') } })
    await financeRequest('operations', 'csrf-in-memory', 'POST', { amount_minor: '9000000000000000' })
    expect(fetch).toHaveBeenCalledWith('/api/finance/operations', expect.objectContaining({ credentials: 'include', cache: 'no-store', body: '{"amount_minor":"9000000000000000"}', headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf-in-memory' }) }))
  })
  it('propagates authorization failures instead of substituting demo data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Sign in' } }), { status: 401 })))
    await expect(financeRequest('snapshot', 'csrf')).rejects.toMatchObject({ status: 401 })
  })
})
