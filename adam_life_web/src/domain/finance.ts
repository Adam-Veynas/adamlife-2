import type { Payment } from './payments'
export type TransactionType = 'income' | 'expense' | 'transfer'
export type Period = 'month' | 'quarter' | 'all'
export type View = 'overview' | 'transactions' | 'analytics' | 'payments'
export type AccountId = 'kaspi' | 'freedom' | 'cash'
export const accountNames: Record<AccountId, string> = { kaspi: 'Kaspi', freedom: 'Freedom', cash: 'Наличные' }
export interface Account { id: AccountId; openingBalanceMinor: number }

export interface Transaction {
  id: string
  type: TransactionType
  /** Integer tiyn: keep arithmetic exact; format only at the UI boundary. */
  amountMinor: number
  date: string
  category: string
  comment: string
  source: 'manual' | 'demo' | 'demo-import'
  /** Missing only in older saved prototypes; interpreted as Kaspi. */
  accountId?: AccountId
  toAccountId?: AccountId
}

export interface PrototypeData {
  version: 1
  openingBalanceMinor: number
  transactions: Transaction[]
  accounts?: Account[]
  payments?: Payment[]
}

export const incomeCategories = ['Зарплата', 'Бонус', 'Подработка', 'Другое']
export const expenseCategories = ['Продукты', 'Жильё', 'Транспорт', 'Развлечения', 'Кредиты', 'Покупки', 'Здоровье', 'Другое']
export const categoryColors: Record<string, string> = {
  Продукты: '#87b69c', Жильё: '#8e9fb6', Транспорт: '#bda98c',
  Развлечения: '#a89abd', Кредиты: '#8eaaa8', Покупки: '#c49484',
  Здоровье: '#b1b990', Другое: '#777d7b',
}

export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function parseAmount(input: string): number | null {
  const normalized = input.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.')
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const [whole, decimals = ''] = normalized.split('.')
  const amount = Number(whole) * 100 + Number(decimals.padEnd(2, '0'))
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 100_000_000_000_00 ? amount : null
}

export function amountInput(minor: number): string {
  return `${Math.floor(minor / 100)}${minor % 100 ? `,${String(minor % 100).padStart(2, '0')}` : ''}`
}

export function money(minor: number, options: { compact?: boolean; sign?: boolean } = {}): string {
  const value = minor / 100
  const text = new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: minor % 100 ? 2 : 0,
    minimumFractionDigits: options.compact ? 0 : minor % 100 ? 2 : 0,
    ...(options.compact ? { notation: 'compact', maximumFractionDigits: 1 } : {}),
  }).format(value)
  return `${options.sign && minor > 0 ? '+' : ''}${text} ₸`
}

export function monthLabel(month: Date): string {
  const label = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(month).replace(' г.', '')
  return label[0].toUpperCase() + label.slice(1)
}

export function dateLabel(date: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00`)).replace('.', '')
}

export function shiftMonth(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1)
}

export function filterPeriod(items: Transaction[], month: Date, period: Period): Transaction[] {
  const end = localDate(shiftMonth(month, 1))
  const start = localDate(shiftMonth(month, period === 'quarter' ? -2 : 0))
  return items.filter(item => period === 'all' || (item.date >= start && item.date < end))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
}

export function totals(items: Transaction[]) {
  return items.reduce((result, item) => {
    if (item.type !== 'transfer') result[item.type] += item.amountMinor
    result.net = result.income - result.expense
    return result
  }, { income: 0, expense: 0, net: 0 })
}

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2100-12-31') return false
  const date = new Date(`${value}T12:00:00`)
  return !Number.isNaN(date.getTime()) && localDate(date) === value
}

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function accountOf(item: Transaction): AccountId { return item.accountId ?? 'kaspi' }
export function operationCount(count: number): string {
  const form = new Intl.PluralRules('ru').select(count)
  return `${count} ${form === 'one' ? 'операция' : form === 'few' ? 'операции' : 'операций'}`
}
export function accountLabel(item: Transaction): string {
  return item.type === 'transfer' ? `${accountNames[accountOf(item)]} → ${accountNames[item.toAccountId ?? 'cash']}` : accountNames[accountOf(item)]
}

export function accountsFor(data: PrototypeData): Account[] {
  // Additive migration: splitting opening funds never changes the original total.
  return data.accounts ?? [
    { id: 'kaspi', openingBalanceMinor: data.openingBalanceMinor - 20000000 - 30000000 },
    { id: 'freedom', openingBalanceMinor: 20000000 },
    { id: 'cash', openingBalanceMinor: 30000000 },
  ]
}

export function accountBalances(data: PrototypeData) {
  return accountsFor(data).map(account => ({ ...account, balance: data.transactions.reduce((sum, row) => {
    if (row.type === 'transfer') return sum - (accountOf(row) === account.id ? row.amountMinor : 0) + (row.toAccountId === account.id ? row.amountMinor : 0)
    return sum + (accountOf(row) === account.id ? row.amountMinor * (row.type === 'income' ? 1 : -1) : 0)
  }, account.openingBalanceMinor) }))
}

export interface FinanceFilter { month: Date; period: Period; account: AccountId | 'all' }
export interface OperationFilter extends FinanceFilter { query?: string; kind?: TransactionType | 'all'; category?: string; sort?: 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc' }
export function queryTransactions(items: Transaction[], filter: OperationFilter): Transaction[] {
  const query = (filter.query ?? '').trim().toLocaleLowerCase('ru')
  return filterPeriod(items, filter.month, filter.period).filter(row =>
    (filter.account === 'all' || accountOf(row) === filter.account || (row.type === 'transfer' && row.toAccountId === filter.account)) &&
    (!filter.kind || filter.kind === 'all' || row.type === filter.kind) && (!filter.category || row.category === filter.category) &&
    `${row.comment} ${row.category} ${accountLabel(row)} ${amountInput(row.amountMinor)}`.toLocaleLowerCase('ru').includes(query))
    .sort((a, b) => {
      const date = b.date.localeCompare(a.date) || b.id.localeCompare(a.id)
      return filter.sort === 'date-asc' ? -date : filter.sort === 'amount-desc' ? b.amountMinor - a.amountMinor || date : filter.sort === 'amount-asc' ? a.amountMinor - b.amountMinor || date : date
    })
}

export function periodBounds(items: Transaction[], month: Date, period: Period, now = new Date()) {
  const financial = items.filter(row => row.type !== 'transfer')
  const start = period === 'all' ? (financial.map(row => row.date).sort()[0] ?? localDate(now)) : localDate(shiftMonth(month, period === 'quarter' ? -2 : 0))
  const last = period === 'all' ? (financial.map(row => row.date).sort().at(-1) ?? localDate(now)) : localDate(new Date(month.getFullYear(), month.getMonth() + 1, 0))
  const today = localDate(now)
  const end = period === 'all' ? (last < today ? today : last) : (start <= today && today < last ? today : last)
  // UTC dates avoid DST changing the number of calendar days.
  const days = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1)
  return { start, end, days }
}

export function dailySeries(items: Transaction[], month: Date, period: Period, type: 'income' | 'expense', cumulative: boolean, now = new Date()) {
  const { start, end } = periodBounds(items, month, period, now)
  const latest = items.filter(row => row.type !== 'transfer').map(row => row.date).sort().at(-1) ?? end
  const days = Math.max(1, Math.round((Date.parse(latest > end ? latest : end) - Date.parse(start)) / 86400000) + 1)
  const sums = new Map<string, number>()
  for (const row of items) if (row.type === type) sums.set(row.date, (sums.get(row.date) ?? 0) + row.amountMinor)
  let total = 0
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.parse(start) + index * 86400000).toISOString().slice(0, 10)
    const amount = sums.get(date) ?? 0
    total += amount
    return { date, amount: cumulative ? total : amount }
  })
}

export function expenseChange(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? 'Без изменений' : 'Нет базы для сравнения'
  const percent = Math.round((current - previous) / previous * 100)
  return `${percent > 0 ? '+' : ''}${percent}% к предыдущему месяцу`
}

export function categoryTotals(items: Transaction[]) {
  const sums = new Map<string, number>()
  for (const item of items) if (item.type === 'expense') sums.set(item.category, (sums.get(item.category) ?? 0) + item.amountMinor)
  const total = [...sums.values()].reduce((sum, amount) => sum + amount, 0)
  return [...sums].map(([name, amount]) => ({ name, amount, share: total ? amount / total : 0, color: categoryColors[name] ?? '#777d7b' }))
    .sort((a, b) => b.amount - a.amount)
}

export function monthlySeries(items: Transaction[], month: Date) {
  return Array.from({ length: 6 }, (_, index) => {
    const date = shiftMonth(month, index - 5)
    return { date, label: new Intl.DateTimeFormat('ru-RU', { month: 'short' }).format(date).replace('.', ''), ...totals(filterPeriod(items, date, 'month')) }
  })
}

export function createDemoData(now = new Date()): PrototypeData {
  const rows: Array<[number, TransactionType, number, string, string]> = [
    [1, 'income', 480000, 'Зарплата', 'Основная работа'],
    [2, 'expense', 85000, 'Жильё', 'Аренда квартиры'],
    [3, 'expense', 18750, 'Продукты', 'Magnum'],
    [4, 'expense', 12400, 'Транспорт', 'Заправка · АИ-95'],
    [5, 'expense', 15900, 'Покупки', 'Kaspi Магазин'],
    [7, 'income', 85000, 'Подработка', 'Дизайн-проект'],
    [8, 'expense', 4260, 'Продукты', 'Small'],
    [10, 'expense', 12500, 'Здоровье', 'Приём у стоматолога'],
    [12, 'expense', 8200, 'Развлечения', 'Кино и ужин'],
    [14, 'expense', 35000, 'Кредиты', 'Ежемесячный платёж'],
    [15, 'income', 120000, 'Бонус', 'Бонус за квартал'],
    [16, 'expense', 27580, 'Продукты', 'Magnum · покупки на неделю'],
    [18, 'expense', 3450, 'Транспорт', 'Яндекс Go'],
    [19, 'expense', 8900, 'Покупки', 'Книга и канцелярия'],
    [20, 'expense', 4800, 'Развлечения', 'Кофе с друзьями'],
    [21, 'expense', 10190, 'Продукты', 'Small · продукты домой'],
    [22, 'expense', 3900, 'Транспорт', 'Яндекс Go · домой'],
  ]
  const transactions: Transaction[] = rows.map(([day, type, amount, category, comment], i) => ({
    id: `demo-current-${i}`, type, amountMinor: amount * 100,
    date: localDate(new Date(now.getFullYear(), now.getMonth(), Math.min(day, now.getDate()))),
    category, comment, source: 'demo',
  }))
  for (let offset = 1; offset <= 5; offset++) {
    const month = shiftMonth(now, -offset)
    transactions.push({ id: `demo-income-${offset}`, type: 'income', amountMinor: (480000 + offset * 8000) * 100, date: localDate(new Date(month.getFullYear(), month.getMonth(), 1)), category: 'Зарплата', comment: 'Основная работа', source: 'demo' })
    expenseCategories.forEach((category, index) => transactions.push({ id: `demo-expense-${offset}-${index}`, type: 'expense', amountMinor: Math.round((index === 1 ? 85000 : 31000 - index * 2100) * (1 + (offset % 3) * .11)) * 100, date: localDate(new Date(month.getFullYear(), month.getMonth(), index * 3 + 2)), category, comment: ['Покупки на неделю', 'Аренда квартиры', 'Поездки и топливо', 'Кафе и кино', 'Ежемесячный платёж', 'Для дома', 'Аптека', 'Личные расходы'][index], source: 'demo' }))
  }
  // Set a believable demo opening balance; this is not a bank-connected balance.
  return { version: 1, openingBalanceMinor: 81900000, transactions }
}

export function demoImportRows(month: Date): Transaction[] {
  return [
    { id: 'prototype-import-1', type: 'expense', amountMinor: 1285000, category: 'Продукты', comment: 'Magnum · пример из выписки' },
    { id: 'prototype-import-2', type: 'expense', amountMinor: 245000, category: 'Транспорт', comment: 'Яндекс Go · пример из выписки' },
    { id: 'prototype-import-3', type: 'income', amountMinor: 2500000, category: 'Подработка', comment: 'Оплата проекта · пример из выписки' },
  ].map(row => ({ ...row, type: row.type as TransactionType, date: localDate(new Date(month.getFullYear(), month.getMonth(), 20)), source: 'demo-import' as const }))
}
