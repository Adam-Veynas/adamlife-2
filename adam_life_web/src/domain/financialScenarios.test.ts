import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountBalances, amountInput, createDemoData, parseAmount, queryTransactions, totals, type AccountId, type FinanceFilter, type PrototypeData, type Transaction } from './finance'
import { deleteTransaction, markPaymentPaid, savePayment, saveTransaction, transactionFromDraft, type TransactionDraft } from './mutations'
import { paymentOccurrences, paymentTotals, type Payment } from './payments'
import { prepareData, prototypeRepository } from '../data/prototypeRepository'

const month = new Date(2026, 9, 1), today = new Date(2026, 9, 23, 12)
const seed = () => prepareData(createDemoData(today))
const balance = (data: PrototypeData, account: AccountId) => accountBalances(data).find(row => row.id === account)!.balance
const totalBalance = (data: PrototypeData) => accountBalances(data).reduce((sum, row) => sum + row.balance, 0)
const item = (changes: Partial<Transaction> = {}): Transaction => ({ id: 'scenario', type: 'expense', accountId: 'kaspi', amountMinor: 123456, date: '2026-10-23', category: 'Продукты', comment: 'Проверка', source: 'manual', ...changes })
const draft = (changes: Partial<TransactionDraft> = {}): TransactionDraft => ({ id: 'draft', type: 'expense', accountId: 'kaspi', amount: '1234,56', date: '2026-10-23', category: 'Продукты', comment: '', source: 'manual', ...changes })
const obligation = (changes: Partial<Payment> = {}): Payment => ({ id: 'p-new', title: 'Подписка', amountMinor: 99909, dueDate: '2026-10-22', frequency: 'monthly', kind: 'Подписка', accountId: 'kaspi', paid: {}, ...changes })
afterEach(() => vi.unstubAllGlobals())

describe('реальные функции действий приложения: доходы, расходы и остатки', () => {
  it.each(['kaspi', 'freedom', 'cash'] as const)('расход уменьшает только выбранный счёт %s', accountId => {
    const before = seed(), untouched = JSON.stringify(before)
    const after = saveTransaction(before, item({ accountId }))
    expect(balance(after, accountId)).toBe(balance(before, accountId) - 123456)
    for (const other of ['kaspi', 'freedom', 'cash'] as const) if (other !== accountId) expect(balance(after, other)).toBe(balance(before, other))
    expect(totalBalance(after)).toBe(totalBalance(before) - 123456)
    expect(totals(after.transactions).expense).toBe(totals(before.transactions).expense + 123456)
    expect(JSON.stringify(before)).toBe(untouched)
  })
  it.each(['kaspi', 'freedom', 'cash'] as const)('доход увеличивает только выбранный счёт %s', accountId => {
    const before = seed(), after = saveTransaction(before, item({ accountId, type: 'income', category: 'Бонус' }))
    expect(balance(after, accountId)).toBe(balance(before, accountId) + 123456)
    for (const other of ['kaspi', 'freedom', 'cash'] as const) if (other !== accountId) expect(balance(after, other)).toBe(balance(before, other))
    expect(totalBalance(after)).toBe(totalBalance(before) + 123456)
    expect(totals(after.transactions).income).toBe(totals(before.transactions).income + 123456)
    expect(totals(after.transactions).expense).toBe(totals(before.transactions).expense)
  })
  it.each([['kaspi', 'freedom'], ['freedom', 'kaspi'], ['kaspi', 'cash'], ['cash', 'kaspi'], ['freedom', 'cash'], ['cash', 'freedom']] as const)('перевод %s → %s меняет два счёта, но не общий баланс/статистику', (accountId, toAccountId) => {
    const before = seed(), after = saveTransaction(before, item({ type: 'transfer', accountId, toAccountId, category: 'Перевод' }))
    expect(balance(after, accountId)).toBe(balance(before, accountId) - 123456)
    expect(balance(after, toAccountId)).toBe(balance(before, toAccountId) + 123456)
    expect(totalBalance(after)).toBe(totalBalance(before))
    expect(totals(after.transactions)).toEqual(totals(before.transactions))
    expect(after.transactions).toHaveLength(before.transactions.length + 1)
  })
  it('редактирование меняет сумму, счёт, тип и дату, а не добавляет вторую запись', () => {
    const before = seed(), expense = item(), added = saveTransaction(before, expense)
    const edited = saveTransaction(added, { ...expense, amountMinor: 54321, accountId: 'freedom', type: 'income', category: 'Бонус', date: '2026-09-23' })
    expect(edited.transactions).toHaveLength(added.transactions.length)
    expect(balance(edited, 'kaspi')).toBe(balance(before, 'kaspi'))
    expect(balance(edited, 'freedom')).toBe(balance(before, 'freedom') + 54321)
    expect(totals(edited.transactions).expense).toBe(totals(before.transactions).expense)
    expect(totals(edited.transactions).income).toBe(totals(before.transactions).income + 54321)
    const current = { month, period: 'month' as const, account: 'all' as const }
    expect(queryTransactions(edited.transactions, current)).toEqual(queryTransactions(before.transactions, current))
  })
  it.each(['expense', 'income', 'transfer'] as const)('удаление %s полностью восстанавливает суммы', type => {
    const before = seed(), added = saveTransaction(before, item({ type, toAccountId: type === 'transfer' ? 'cash' : undefined }))
    const after = deleteTransaction(added, 'scenario')
    expect(accountBalances(after)).toEqual(accountBalances(before))
    expect(totals(after.transactions)).toEqual(totals(before.transactions))
    expect(after.transactions).toEqual(before.transactions)
  })
  it('редактирование перевода отменяет старое движение и применяет новое ровно один раз', () => {
    const before = seed(), transfer = item({ type: 'transfer', toAccountId: 'cash' })
    const after = saveTransaction(saveTransaction(before, transfer), { ...transfer, accountId: 'freedom', toAccountId: 'kaspi', amountMinor: 12345 })
    expect(balance(after, 'cash')).toBe(balance(before, 'cash'))
    expect(balance(after, 'freedom')).toBe(balance(before, 'freedom') - 12345)
    expect(balance(after, 'kaspi')).toBe(balance(before, 'kaspi') + 12345)
    expect(totalBalance(after)).toBe(totalBalance(before))
  })
  it('фильтры операций и сводка аналитики согласованы с известными суммами, переводы исключены', () => {
    const data = { ...seed(), transactions: [item({ id: 'a', amountMinor: 101 }), item({ id: 'b', amountMinor: 202 }), item({ id: 'income', type: 'income', amountMinor: 500 }), item({ id: 'transfer', type: 'transfer', toAccountId: 'cash', amountMinor: 900 }), item({ id: 'other-account', accountId: 'freedom', amountMinor: 303 }), item({ id: 'old', date: '2026-09-30', amountMinor: 404 })] }
    const filter: FinanceFilter = { month, period: 'month', account: 'kaspi' }
    const operations = queryTransactions(data.transactions, { ...filter, kind: 'all' })
    const analytics = queryTransactions(data.transactions, filter).filter(row => row.type !== 'transfer')
    expect(operations).toHaveLength(4); expect(analytics).toHaveLength(3)
    expect(totals(operations)).toEqual({ income: 500, expense: 303, net: 197 })
    expect(totals(analytics)).toEqual(totals(operations))
    expect(queryTransactions(data.transactions, { ...filter, kind: 'expense', category: 'Продукты', query: 'Проверка' }).map(row => row.id).sort()).toEqual(['a', 'b'])
  })
  it('ввод → добавление → редактирование → сохранение → перезагрузка не теряют тиыны', () => {
    let raw: string | null = null
    vi.stubGlobal('localStorage', { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value } })
    const before = seed()
    let data = saveTransaction(before, transactionFromDraft(draft({ amount: '0,10' })))
    data = saveTransaction(data, transactionFromDraft(draft({ id: 'second', amount: '0,20' })))
    expect(balance(data, 'kaspi')).toBe(balance(before, 'kaspi') - 30)
    const changed = transactionFromDraft(draft({ amount: amountInput(123457) }))
    data = saveTransaction(data, changed)
    expect(prototypeRepository.save(data)).toBe(true)
    const reloaded = prototypeRepository.load()
    expect(reloaded.warning).toBeUndefined()
    expect(reloaded.data.transactions.find(row => row.id === 'draft')!.amountMinor).toBe(123457)
    expect(accountBalances(reloaded.data)).toEqual(accountBalances(data))
    expect(parseAmount(amountInput(changed.amountMinor))).toBe(changed.amountMinor)
  })
})

describe('некорректный ввод не проходит в состояние приложения', () => {
  it.each(['0', '0,00', '-1', '-0,01', 'NaN', 'Infinity', '1e3', '12.345', '1,2,3', '', ' ', 'abc', '100000000001'])('форма и общий обработчик не сохраняют сумму "%s"', amount => {
    const before = seed(), original = JSON.stringify(before)
    expect(() => saveTransaction(before, transactionFromDraft(draft({ amount })))).toThrow()
    expect(JSON.stringify(before)).toBe(original)
  })
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('нельзя обойти форму и сохранить amountMinor=%s', amountMinor => {
    expect(() => saveTransaction(seed(), item({ amountMinor }))).toThrow()
  })
  it.each(['kaspi', 'freedom', 'cash'] as const)('перевод %s → тот же счёт запрещён и в форме, и в действиях', accountId => {
    expect(() => transactionFromDraft(draft({ type: 'transfer', accountId, toAccountId: accountId }))).toThrow(/разные счета/)
    expect(() => saveTransaction(seed(), item({ type: 'transfer', accountId, toAccountId: accountId }))).toThrow(/разные счета/)
  })
})

describe('обязательства: изменения данных и отсутствие двойного учёта', () => {
  it('добавление и изменение обязательства пересчитывают месяц, не трогая банковские остатки', () => {
    const before = { ...seed(), payments: [] }, payment = obligation()
    const added = savePayment(before, payment), edited = savePayment(added, { ...payment, amountMinor: 123456 })
    expect(added.payments).toHaveLength(1); expect(edited.payments).toHaveLength(1)
    expect(paymentTotals(paymentOccurrences(added.payments!, month, today))).toEqual({ total: 99909, paid: 0, remaining: 99909, overdue: 99909 })
    expect(paymentTotals(paymentOccurrences(edited.payments!, month, today))).toEqual({ total: 123456, paid: 0, remaining: 123456, overdue: 123456 })
    expect(accountBalances(edited)).toEqual(accountBalances(before))
  })
  it('просрочено — подмножество остатка, не отдельная прибавка', () => {
    const payments = [obligation({ id: 'late', amountMinor: 10001 }), obligation({ id: 'today', dueDate: '2026-10-23', amountMinor: 20002 }), obligation({ id: 'future', dueDate: '2026-10-30', amountMinor: 30003 }), obligation({ id: 'paid', amountMinor: 40004, paid: { '2026-10': { date: '2026-10-20' } } })]
    const rows = paymentOccurrences(payments, month, today), result = paymentTotals(rows)
    expect(result).toEqual({ total: 100010, paid: 40004, remaining: 60006, overdue: 10001 })
    expect(result.total).toBe(result.paid + result.remaining)
    expect(result.overdue).toBeLessThanOrEqual(result.remaining)
    expect(rows.find(row => row.payment.id === 'today')!.status).toBe('expected')
  })
  it('оплата просроченного меняет статус и оба остатка обязательств, не создаёт расход', () => {
    const before = savePayment({ ...seed(), payments: [] }, obligation())
    const row = paymentOccurrences(before.payments!, month, today)[0]
    const paid = markPaymentPaid(before, row, '2026-10-23')
    expect(paymentTotals(paymentOccurrences(paid.payments!, month, today))).toEqual({ total: 99909, paid: 99909, remaining: 0, overdue: 0 })
    expect(paid.transactions).toBe(before.transactions)
    expect(accountBalances(paid)).toEqual(accountBalances(before))
    expect(markPaymentPaid(paid, row, '2026-10-23')).toBe(paid)
  })
  it('связанная оплата не удваивает уже существующий расход; удаление связи сохраняет отметку', () => {
    const before = savePayment(saveTransaction(seed(), item({ id: 'linked' })), obligation())
    const row = paymentOccurrences(before.payments!.filter(payment => payment.id === 'p-new'), month, today)[0]
    const paid = markPaymentPaid(before, row, '2026-10-23', 'linked')
    expect(paid.transactions).toBe(before.transactions)
    expect(totalBalance(paid)).toBe(totalBalance(before))
    expect(paid.payments!.find(payment => payment.id === 'p-new')!.paid['2026-10'].transactionId).toBe('linked')
    const deleted = deleteTransaction(paid, 'linked')
    expect(deleted.payments!.find(payment => payment.id === 'p-new')!.paid['2026-10']).toEqual({ date: '2026-10-23' })
  })
  it('ежемесячная оплата не переносится в следующий месяц и сохраняется при редактировании', () => {
    const before = savePayment({ ...seed(), payments: [] }, obligation())
    const paid = markPaymentPaid(before, paymentOccurrences(before.payments!, month, today)[0], '2026-10-23')
    const edited = savePayment(paid, obligation({ title: 'Изменённая подписка', dueDate: '2026-10-26' }))
    expect(paymentOccurrences(edited.payments!, month, today)[0].status).toBe('paid')
    expect(paymentOccurrences(edited.payments!, new Date(2026, 10, 1), today)[0].status).toBe('expected')
    expect(paymentTotals(paymentOccurrences(edited.payments!, new Date(2026, 10, 1), today))).toEqual({ total: 99909, paid: 0, remaining: 99909, overdue: 0 })
  })
  it('оплата и просрочка остаются корректны после сохранения и перезагрузки', () => {
    let raw: string | null = null
    vi.stubGlobal('localStorage', { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value } })
    const before = savePayment({ ...seed(), payments: [] }, obligation())
    const paid = markPaymentPaid(before, paymentOccurrences(before.payments!, month, today)[0], '2026-10-23')
    prototypeRepository.save(paid)
    const restored = prototypeRepository.load().data
    expect(paymentTotals(paymentOccurrences(restored.payments!, month, today))).toEqual({ total: 99909, paid: 99909, remaining: 0, overdue: 0 })
    expect(restored.transactions).toEqual(before.transactions)
  })
  it('пустой месяц и отсутствие обязательств дают четыре нуля', () => {
    expect(paymentTotals([])).toEqual({ total: 0, paid: 0, remaining: 0, overdue: 0 })
    expect(paymentOccurrences([obligation({ frequency: 'once', dueDate: '2026-09-22' })], month, today)).toEqual([])
  })
})
