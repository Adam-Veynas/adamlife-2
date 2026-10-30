import { localDate, shiftMonth, type AccountId } from './finance'

export const paymentKinds = ['Кредит', 'Подписка', 'Интернет и связь', 'Другое'] as const
export interface Payment {
  id: string
  title: string
  amountMinor: number
  dueDate: string
  frequency: 'monthly' | 'once'
  kind: typeof paymentKinds[number]
  accountId: AccountId
  /** Each monthly occurrence is paid independently. No second expense is created. */
  paid: Record<string, { date: string; transactionId?: string }>
}
export interface PaymentOccurrence { payment: Payment; date: string; key: string; status: 'paid' | 'overdue' | 'expected' }
export function paymentOccurrences(payments: Payment[], month: Date, now = new Date()): PaymentOccurrence[] {
  const start = localDate(shiftMonth(month, 0)), end = localDate(shiftMonth(month, 1)), today = localDate(now)
  return payments.flatMap(payment => {
    let date = payment.dueDate
    if (payment.frequency === 'monthly') {
      if (payment.dueDate.slice(0, 7) > start.slice(0, 7)) return []
      const day = Math.min(Number(payment.dueDate.slice(8)), new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate())
      date = localDate(new Date(month.getFullYear(), month.getMonth(), day))
    }
    if (date < start || date >= end) return []
    const key = date.slice(0, 7)
    return [{ payment, date, key, status: payment.paid[key] ? 'paid' as const : date < today ? 'overdue' as const : 'expected' as const }]
  }).sort((a, b) => a.date.localeCompare(b.date) || a.payment.id.localeCompare(b.payment.id))
}
export function paymentTotals(rows: PaymentOccurrence[]) {
  const total = rows.reduce((sum, row) => sum + row.payment.amountMinor, 0)
  const paid = rows.filter(row => row.status === 'paid').reduce((sum, row) => sum + row.payment.amountMinor, 0)
  // Overdue is a SUBSET of remaining, never another addition to it.
  const overdue = rows.filter(row => row.status === 'overdue').reduce((sum, row) => sum + row.payment.amountMinor, 0)
  return { total, paid, remaining: total - paid, overdue }
}
export function demoPayments(now = new Date()): Payment[] {
  const date = (day: number) => localDate(new Date(now.getFullYear(), now.getMonth(), day))
  return [
    { id: 'payment-credit', title: 'Рассрочка Kaspi', amountMinor: 3500000, dueDate: date(14), frequency: 'monthly', kind: 'Кредит', accountId: 'kaspi', paid: { [date(14).slice(0, 7)]: { date: date(14), transactionId: 'demo-current-9' } } },
    { id: 'payment-internet', title: 'Домашний интернет', amountMinor: 699000, dueDate: date(25), frequency: 'monthly', kind: 'Интернет и связь', accountId: 'kaspi', paid: {} },
    { id: 'payment-music', title: 'Музыкальная подписка', amountMinor: 149000, dueDate: date(27), frequency: 'monthly', kind: 'Подписка', accountId: 'freedom', paid: {} },
    { id: 'payment-mobile', title: 'Мобильная связь', amountMinor: 499000, dueDate: date(30 > new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() ? 28 : 30), frequency: 'monthly', kind: 'Интернет и связь', accountId: 'kaspi', paid: {} },
    { id: 'payment-gym', title: 'Абонемент в зал', amountMinor: 1800000, dueDate: date(10), frequency: 'monthly', kind: 'Другое', accountId: 'freedom', paid: {} },
  ]
}
