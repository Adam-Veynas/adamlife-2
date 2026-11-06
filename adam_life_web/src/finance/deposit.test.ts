import { describe, expect, it } from 'vitest'
import { depositDetails, depositFormValues, type Account } from './client'

const legacy: Account = { id: 'a', name: 'Депозит', kind: 'deposit', bank_code: 'bank', currency: 'KZT', opening_date: '2026-01-01', opening_balance_minor: '0', balance_minor: '100', archived: false, version: 1 }

describe('deposit metadata', () => {
  it('keeps decimal precision and separate deposit dates', () => {
    expect(depositFormValues('deposit', 'term', '15,1234', '2020-01-01', '2027-01-01')).toEqual({ deposit_type: 'term', annual_rate: '15.1234', deposit_opened_on: '2020-01-01', deposit_ends_on: '2027-01-01' })
    expect(depositFormValues('deposit', 'savings', '0', '', '').annual_rate).toBe('0')
  })
  it('allows optional fields for both types', () => {
    for (const type of ['savings', 'term'] as const) expect(depositFormValues('deposit', type, '', '', '')).toEqual({ deposit_type: type, annual_rate: null, deposit_opened_on: null, deposit_ends_on: null })
  })
  it.each(['-1', 'NaN', 'Infinity', '1e2', '15.12345', '100000'])('rejects invalid rate %s', rate => {
    expect(() => depositFormValues('deposit', 'term', rate, '', '')).toThrow()
  })
  it('rejects reversed dates and clears hidden fields for regular accounts', () => {
    expect(() => depositFormValues('deposit', 'term', '', '2026-02-01', '2026-01-01')).toThrow()
    expect(depositFormValues('bank', 'term', '15', '2020-01-01', '2027-01-01')).toEqual({ deposit_type: null, annual_rate: null, deposit_opened_on: null, deposit_ends_on: null })
  })
  it('shows old deposits honestly and formats rate and dates', () => {
    expect(depositDetails(legacy)[0]).toEqual(['Тип депозита', 'Не указан'])
    const details = depositDetails({ ...legacy, deposit_type: 'term', annual_rate: '15.1200', deposit_ends_on: '2027-01-01' })
    expect(details).toContainEqual(['Годовая ставка', '15,12 %'])
    expect(details).toContainEqual(['Дата окончания', '01.01.2027'])
    expect(depositDetails({ ...legacy, annual_rate: '0.0000' })).toContainEqual(['Годовая ставка', '0 %'])
  })
})
