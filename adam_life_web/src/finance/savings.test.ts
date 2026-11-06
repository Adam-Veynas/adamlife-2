import { describe, expect, it } from 'vitest'
import { goalFunding, goalHasDeficit, nonnegativeMinor, type Goal, type SavingsAccount } from './savingsClient'

describe('savings input uses exact minor units and exclusive modes', () => {
  it('manual mode never sends hidden account allocations', () => {
    expect(goalFunding('manual', '1 234,56', { a: '900' })).toEqual({ manual_minor: '123456', allocations: [] })
  })
  it('linked mode never sends a hidden manual balance', () => {
    expect(goalFunding('linked', '999999', { a: '0,01', b: '', c: '0' })).toEqual({ manual_minor: null, allocations: [{ account_id: 'a', amount_minor: '1' }] })
  })
  it('keeps large amounts exact without floats', () => {
    expect(nonnegativeMinor('89999999999999.99')).toBe('8999999999999999')
  })
  it('supports clearing all allocations and zero manual progress', () => {
    expect(goalFunding('linked', '', { a: '0' }).allocations).toEqual([])
    expect(goalFunding('manual', '0', {}).manual_minor).toBe('0')
  })
  it.each(['-0.01', 'NaN', '1.234', 'Infinity', '90000000000000.01'])('rejects invalid progress %s', value => {
    expect(() => nonnegativeMinor(value)).toThrow()
  })
  it('reports deficit only for accounts linked to this goal', () => {
    const goal = { allocations: [{ account_id: 'a', amount_minor: '100' }] } as Goal
    const accounts = [{ id: 'a', deficit_minor: '0' }, { id: 'b', deficit_minor: '300' }] as SavingsAccount[]
    expect(goalHasDeficit(goal, accounts)).toBe(false)
    expect(goalHasDeficit(goal, [{ ...accounts[0], deficit_minor: '1' }])).toBe(true)
  })
})
