import { accountBalances, accountNames, accountOf, parseAmount, totals, validDate, type AccountId, type PrototypeData, type Transaction, type TransactionType } from './finance'
import { paymentKinds, paymentOccurrences, type Payment, type PaymentOccurrence } from './payments'

/** Used by the form AND by state mutations; validation cannot be bypassed by another UI. */
export function transactionError(item: Transaction): string | null {
  if (!Number.isSafeInteger(item.amountMinor) || item.amountMinor <= 0 || item.amountMinor > 100_000_000_000_00) return 'Введите положительную сумму — не больше двух знаков после запятой.'
  if (!validDate(item.date)) return 'Укажите корректную дату.'
  if (!Object.hasOwn(accountNames, accountOf(item))) return 'Выберите существующий счёт.'
  if (!['income', 'expense', 'transfer'].includes(item.type)) return 'Выберите тип операции.'
  if (item.type === 'transfer') {
    if (!item.toAccountId || !Object.hasOwn(accountNames, item.toAccountId)) return 'Выберите счёт получения.'
    if (accountOf(item) === item.toAccountId) return 'Выберите разные счета для перевода.'
  }
  if (!item.id.trim() || !item.category.trim()) return 'Укажите категорию операции.'
  return null
}
export interface TransactionDraft { id: string; type: TransactionType; amount: string; date: string; category: string; accountId: AccountId; toAccountId?: AccountId; comment: string; source: Transaction['source'] }
export function transactionFromDraft(draft: TransactionDraft): Transaction {
  const { amount, ...fields } = draft
  const amountMinor = parseAmount(amount)
  if (amountMinor === null) throw new Error('Введите положительную сумму — не больше двух знаков после запятой.')
  const item: Transaction = { ...fields, amountMinor, comment: draft.comment.trim(), category: draft.type === 'transfer' ? 'Перевод' : draft.category }
  if (item.type !== 'transfer') delete item.toAccountId
  const error = transactionError(item)
  if (error) throw new Error(error)
  return item
}
function assertSafeFinancials(data: PrototypeData) {
  const summary = totals(data.transactions), accounts = accountBalances(data)
  if (![summary.income, summary.expense, summary.net, ...accounts.map(account => account.balance), accounts.reduce((sum, account) => sum + account.balance, 0)].every(Number.isSafeInteger)) throw new Error('Итог превышает безопасный диапазон денежных сумм. Операция не сохранена.')
}
export function saveTransaction(data: PrototypeData, item: Transaction): PrototypeData {
  const error = transactionError(item)
  if (error) throw new Error(error)
  const next = { ...data, transactions: data.transactions.some(row => row.id === item.id) ? data.transactions.map(row => row.id === item.id ? item : row) : [...data.transactions, item] }
  assertSafeFinancials(next)
  return next
}
export function deleteTransaction(data: PrototypeData, id: string): PrototypeData {
  return { ...data, transactions: data.transactions.filter(row => row.id !== id), payments: data.payments?.map(payment => ({ ...payment, paid: Object.fromEntries(Object.entries(payment.paid).map(([key, paid]) => [key, paid.transactionId === id ? { date: paid.date } : paid])) })) }
}
export function savePayment(data: PrototypeData, payment: Payment): PrototypeData {
  if (!payment.title.trim() || !payment.id.trim() || !Number.isSafeInteger(payment.amountMinor) || payment.amountMinor <= 0 || payment.amountMinor > 100_000_000_000_00 || !validDate(payment.dueDate) || !paymentKinds.includes(payment.kind) || !['monthly', 'once'].includes(payment.frequency) || !Object.hasOwn(accountNames, payment.accountId)) throw new Error('Заполните название, положительную сумму, счёт и корректную дату платежа.')
  const items = data.payments ?? []
  // Preserve paid occurrences even if a caller edits only the schedule fields.
  const previous = items.find(row => row.id === payment.id)
  const next = { ...payment, title: payment.title.trim(), paid: { ...previous?.paid, ...payment.paid } }
  return { ...data, payments: previous ? items.map(row => row.id === payment.id ? next : row) : [...items, next] }
}
export function markPaymentPaid(data: PrototypeData, occurrence: PaymentOccurrence, date: string, transactionId?: string): PrototypeData {
  if (!validDate(date)) throw new Error('Укажите корректную дату оплаты.')
  const payment = data.payments?.find(row => row.id === occurrence.payment.id)
  if (!payment) throw new Error('Платёж больше не существует.')
  const current = paymentOccurrences([payment], new Date(`${occurrence.date}T12:00:00`)).find(row => row.date === occurrence.date && row.key === occurrence.key)
  if (!current) throw new Error('Дата обязательства изменилась. Откройте его заново.')
  if (payment.paid[occurrence.key]) return data // Repeated confirmation is idempotent.
  if (transactionId && !data.transactions.some(row => row.id === transactionId && row.type === 'expense' && accountOf(row) === payment.accountId && row.date.slice(0, 7) === occurrence.key)) throw new Error('Выберите существующий расход этого счёта и месяца.')
  return { ...data, payments: data.payments!.map(row => row.id === payment.id ? { ...row, paid: { ...row.paid, [occurrence.key]: { date, ...(transactionId ? { transactionId } : {}) } } } : row) }
}
