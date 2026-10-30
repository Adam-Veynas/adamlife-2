import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountBalances, createDemoData } from '../domain/finance'
import { prepareData, prototypeRepository } from './prototypeRepository'

function storage(raw: string | null = null) {
  const result = { getItem: vi.fn(() => raw), setItem: vi.fn(), removeItem: vi.fn() }
  vi.stubGlobal('localStorage', result)
  return result
}

afterEach(() => vi.unstubAllGlobals())

describe('изолированное браузерное хранилище прототипа', () => {
  it('при первом запуске показывает демоданные', () => {
    const local = storage()
    expect(prototypeRepository.load().data.transactions.length).toBeGreaterThan(10)
    expect(local.getItem).toHaveBeenCalledWith('adamlife.web.prototype.v1')
  })
  it('читает ранее сохранённые операции без изменения суммы', () => {
    const data = createDemoData()
    data.transactions[0].amountMinor = 123456
    storage(JSON.stringify(data))
    expect(prototypeRepository.load().data.transactions[0].amountMinor).toBe(123456)
  })
  it('повреждённый JSON не блокирует интерфейс и не удаляется автоматически', () => {
    const local = storage('{invalid')
    expect(prototypeRepository.load().warning).toBeTruthy()
    expect(local.setItem).not.toHaveBeenCalled()
    expect(local.removeItem).not.toHaveBeenCalled()
  })
  it('не принимает неизвестную версию структуры', () => {
    storage(JSON.stringify({ ...createDemoData(), version: 2 }))
    expect(prototypeRepository.load().warning).toBeTruthy()
  })
  it('сообщает о запрете записи вместо ложного успеха', () => {
    const local = storage()
    local.setItem.mockImplementation(() => { throw new Error('quota') })
    expect(prototypeRepository.save(createDemoData())).toBe(false)
  })
  it('переживает недоступность хранилища при загрузке', () => {
    const local = storage()
    local.getItem.mockImplementation(() => { throw new Error('storage blocked') })
    expect(prototypeRepository.load().warning).toContain('недоступно')
  })
  it('сохраняет и восстанавливает счета, тиыны, перевод и отметки оплат', () => {
    let raw: string | null = null
    vi.stubGlobal('localStorage', { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value } })
    const data = prepareData(createDemoData())
    data.transactions.push({ id: 'transfer-test', type: 'transfer', amountMinor: 123456, date: '2026-10-22', category: 'Перевод', comment: '', accountId: 'kaspi', toAccountId: 'cash', source: 'manual' })
    data.payments![0].paid['2026-10'] = { date: '2026-10-22', transactionId: data.transactions[0].id }
    expect(prototypeRepository.save(data)).toBe(true)
    const restored = prototypeRepository.load()
    expect(restored.warning).toBeUndefined(); expect(restored.data).toEqual(data)
    expect(accountBalances(restored.data)).toEqual(accountBalances(data))
  })
  it('отклоняет перевод в тот же счёт и неверную календарную дату', () => {
    const data = prepareData(createDemoData())
    data.transactions[0] = { ...data.transactions[0], type: 'transfer', accountId: 'kaspi', toAccountId: 'kaspi' }
    storage(JSON.stringify(data)); expect(prototypeRepository.load().warning).toBeTruthy()
    data.transactions[0] = { ...data.transactions[0], type: 'expense', date: '2026-02-31' }
    storage(JSON.stringify(data)); expect(prototypeRepository.load().warning).toBeTruthy()
  })
})
