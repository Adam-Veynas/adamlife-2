export type Currency = 'KZT' | 'USD' | 'EUR'
export type Kind = 'income' | 'expense' | 'transfer'
export type DepositType = 'savings' | 'term'
export interface Account { id: string; name: string; kind: 'bank' | 'cash' | 'deposit'; bank_code: string | null; currency: Currency; opening_date: string; opening_balance_minor: string; balance_minor: string; archived: boolean; version: number; deposit_type?: DepositType | null; annual_rate?: string | null; deposit_opened_on?: string | null; deposit_ends_on?: string | null }

export function depositFormValues(kind: Account['kind'], type: DepositType, rate: string, opened: string, ends: string) {
  if (kind !== 'deposit') return { deposit_type: null, annual_rate: null, deposit_opened_on: null, deposit_ends_on: null }
  const normalized = rate.trim().replace(',', '.').replace(/^0+(?=\d)/, '')
  if (normalized && !/^\d{1,5}(?:\.\d{1,4})?$/.test(normalized)) throw new Error('Укажите неотрицательную ставку: до 4 знаков после запятой')
  if (opened && ends && ends < opened) throw new Error('Дата окончания не может быть раньше даты открытия')
  return { deposit_type: type, annual_rate: normalized || null, deposit_opened_on: opened || null, deposit_ends_on: ends || null }
}

export function depositDetails(account: Account): [string, string][] {
  if (account.kind !== 'deposit') return []
  const dateLabel = (value?: string | null) => value ? value.split('-').reverse().join('.') : 'Не указана'
  return [
    ['Тип депозита', account.deposit_type === 'term' ? 'Срочный' : account.deposit_type === 'savings' ? 'Накопительный' : 'Не указан'],
    ['Годовая ставка', account.annual_rate == null ? 'Не указана' : account.annual_rate.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace('.', ',') + ' %'],
    ['Дата открытия', dateLabel(account.deposit_opened_on)], ['Дата окончания', dateLabel(account.deposit_ends_on)],
  ]
}
export interface Category { id: string; name: string; kind: 'income' | 'expense'; archived: boolean; version: number }
export interface Operation { id: string; kind: Kind; account_id: string; destination_account_id: string | null; category_id: string | null; currency: Currency; amount_minor: string; occurred_on: string; comment: string; version: number; adjustment_type?: 'refund' | 'reversal' | 'fx' | 'return_funds' | null; related_transaction_id?: string | null; expense_correction_minor?: string; correction_category_id?: string | null; adjustment_pending?: boolean }
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
// Derived by the API from the linked original, never a second money movement.
export function expenseCorrection(row: Operation) { return BigInt(row.expense_correction_minor ?? '0') }
export function reportingKind(row: Operation) { return expenseCorrection(row) > 0n ? 'expense' : row.adjustment_type ? null : row.kind }
export function reportingCategory(row: Operation) { return expenseCorrection(row) > 0n ? row.correction_category_id ?? null : row.category_id }
export function reportingAmount(row: Operation) { return expenseCorrection(row) > 0n ? -expenseCorrection(row) : BigInt(row.amount_minor) }
export function totals(rows: Operation[]) {
  let income = 0n, expense = 0n
  for (const row of rows) { const kind = reportingKind(row); if (kind === 'income') income += reportingAmount(row); if (kind === 'expense') expense += reportingAmount(row) }
  return { income, expense, net: income - expense }
}
export interface Filters { currency: Currency; account: string; accounts?: string[]; kind: string; category: string; categoryUnassigned?: boolean; from: string; to: string }
export function filterOperations(rows: Operation[], filter: Filters) {
  return rows.filter(row => row.currency === filter.currency && (!filter.account || row.account_id === filter.account || row.destination_account_id === filter.account) &&
    (!filter.accounts?.length || filter.accounts.includes(row.account_id) || (row.destination_account_id !== null && filter.accounts.includes(row.destination_account_id))) &&
    (!filter.kind || (filter.kind === 'adjustment' ? !!row.adjustment_type : reportingKind(row) === filter.kind)) && (!filter.category || reportingCategory(row) === filter.category) && (!filter.categoryUnassigned || reportingCategory(row) === null) &&
    (!filter.from || row.occurred_on >= filter.from) && (!filter.to || row.occurred_on <= filter.to))
}

export function movement(row: Operation, account: string): string {
  const negative = row.kind === 'expense' || (row.kind === 'transfer' && account === row.account_id)
  const positive = row.kind === 'income' || (row.kind === 'transfer' && account === row.destination_account_id)
  return `${negative ? '−' : positive ? '+' : ''}${formatMoney(row.amount_minor, row.currency)}`
}

// Hidden rate is intentionally omitted: the API preserves existing metadata.
export function depositEditorValues(kind: Account['kind'], type: DepositType, opened: string, ends: string) {
  if (kind === 'deposit' && opened && ends && ends < opened) throw new Error('Дата окончания не может быть раньше даты открытия')
  return { deposit_type: kind === 'deposit' ? type : null, deposit_opened_on: kind === 'deposit' ? opened || null : null, deposit_ends_on: kind === 'deposit' ? ends || null : null }
}
