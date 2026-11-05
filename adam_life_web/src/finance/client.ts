export type Currency = 'KZT' | 'USD' | 'EUR'
export type Kind = 'income' | 'expense' | 'transfer'
export interface Account { id: string; name: string; kind: 'bank' | 'cash' | 'deposit'; bank_code: string | null; currency: Currency; opening_date: string; opening_balance_minor: string; balance_minor: string; archived: boolean; version: number }
export interface Category { id: string; name: string; kind: 'income' | 'expense'; archived: boolean; version: number }
export interface Operation { id: string; kind: Kind; account_id: string; destination_account_id: string | null; category_id: string | null; currency: Currency; amount_minor: string; occurred_on: string; comment: string; version: number }
export interface Snapshot { as_of: string; accounts: Account[]; categories: Category[]; operations: Operation[]; balances: Record<Currency, { total_minor: string; current_minor: string; deposit_minor: string }> }
export class FinanceError extends Error { constructor(public status: number, message: string) { super(message) } }
export async function financeRequest<T>(path: string, csrf: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/finance/' + path, { method, credentials: 'include', cache: 'no-store',
    signal: signal ?? AbortSignal.timeout(20000), headers: { Accept: 'application/json', ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    const message = data?.error?.message
    throw new FinanceError(response.status, typeof message === 'string' ? message : 'Не удалось выполнить запрос')
  }
  return response.json() as Promise<T>
}

export function parseMinor(value: string, signed = false): string {
  const normalized = value.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.')
  if (!(signed ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/).test(normalized)) throw new Error('Укажите сумму с точностью до двух знаков')
  const negative = normalized.startsWith('-'), [whole, fraction = ''] = normalized.replace('-', '').split('.')
  const amount = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * (negative ? -1n : 1n)
  if (amount > 9000000000000000n || amount < -9000000000000000n || (!signed && amount <= 0n)) throw new Error('Сумма должна быть положительной и не превышать 90 трлн')
  return amount.toString()
}
export function amountText(value: string): string {
  const n = BigInt(value), abs = n < 0n ? -n : n
  return `${n < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`
}
export function formatMoney(value: string | bigint, currency: Currency): string {
  const n = BigInt(value), abs = n < 0n ? -n : n
  return `${n < 0n ? '−' : ''}${new Intl.NumberFormat('ru-RU').format(abs / 100n)}${abs % 100n ? ',' + (abs % 100n).toString().padStart(2, '0') : ''} ${{ KZT: '₸', USD: '$', EUR: '€' }[currency]}`
}
export function totals(rows: Operation[]) {
  let income = 0n, expense = 0n
  for (const row of rows) { if (row.kind === 'income') income += BigInt(row.amount_minor); if (row.kind === 'expense') expense += BigInt(row.amount_minor) }
  return { income, expense, net: income - expense }
}
export interface Filters { currency: Currency; account: string; kind: string; category: string; from: string; to: string }
export function filterOperations(rows: Operation[], filter: Filters) {
  return rows.filter(row => row.currency === filter.currency && (!filter.account || row.account_id === filter.account || row.destination_account_id === filter.account) &&
    (!filter.kind || row.kind === filter.kind) && (!filter.category || row.category_id === filter.category) &&
    (!filter.from || row.occurred_on >= filter.from) && (!filter.to || row.occurred_on <= filter.to))
}

export function movement(row: Operation, account: string): string {
  const negative = row.kind === 'expense' || (row.kind === 'transfer' && account === row.account_id)
  const positive = row.kind === 'income' || (row.kind === 'transfer' && account === row.destination_account_id)
  return `${negative ? '−' : positive ? '+' : ''}${formatMoney(row.amount_minor, row.currency)}`
}
