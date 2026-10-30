import { accountsFor, createDemoData, validDate, type AccountId, type PrototypeData } from '../domain/finance'
import { demoPayments, paymentKinds } from '../domain/payments'

const STORAGE_KEY = 'adamlife.web.prototype.v1'

function isData(value: unknown): value is PrototypeData {
  if (!value || typeof value !== 'object') return false
  const data = value as PrototypeData
  return data.version === 1 && Number.isSafeInteger(data.openingBalanceMinor) && Array.isArray(data.transactions) && data.transactions.every(item =>
    item && typeof item.id === 'string' && ['income', 'expense', 'transfer'].includes(item.type) &&
    Number.isSafeInteger(item.amountMinor) && item.amountMinor > 0 && typeof item.date === 'string' &&
    validDate(item.date) &&
    typeof item.category === 'string' && typeof item.comment === 'string' &&
    ['manual', 'demo', 'demo-import'].includes(item.source) &&
    (item.accountId === undefined || ['kaspi', 'freedom', 'cash'].includes(item.accountId)) &&
    (item.type !== 'transfer' || (!!item.accountId && !!item.toAccountId && ['kaspi', 'freedom', 'cash'].includes(item.toAccountId) && item.accountId !== item.toAccountId))) &&
    new Set(data.transactions.map(row => row.id)).size === data.transactions.length &&
    (data.accounts === undefined || (Array.isArray(data.accounts) && data.accounts.length === 3 && new Set(data.accounts.map(row => row.id)).size === 3 && data.accounts.every(row => row && ['kaspi', 'freedom', 'cash'].includes(row.id) && Number.isSafeInteger(row.openingBalanceMinor)) && data.accounts.reduce((sum, row) => sum + row.openingBalanceMinor, 0) === data.openingBalanceMinor)) &&
    (data.payments === undefined || (Array.isArray(data.payments) && data.payments.every(row => row && typeof row.id === 'string' && typeof row.title === 'string' && Number.isSafeInteger(row.amountMinor) && row.amountMinor > 0 && validDate(row.dueDate) && ['monthly', 'once'].includes(row.frequency) && paymentKinds.includes(row.kind) && ['kaspi', 'freedom', 'cash'].includes(row.accountId) && row.paid && typeof row.paid === 'object' && Object.entries(row.paid).every(([key, paid]) => /^\d{4}-\d{2}$/.test(key) && paid && validDate(paid.date) && (paid.transactionId === undefined || typeof paid.transactionId === 'string')))))
}

/** Extend v1 additively: keep amounts, IDs, comments and the original storage key. */
export function prepareData(data: PrototypeData): PrototypeData {
  return { ...data, accounts: accountsFor(data), payments: data.payments ?? demoPayments(), transactions: data.transactions.map((row, index) => ({ ...row, accountId: row.accountId ?? (row.source === 'demo' ? (index % 5 === 0 ? 'freedom' : index % 7 === 0 ? 'cash' : 'kaspi') : 'kaspi') as AccountId })) }
}

/** Frontend-only adapter. Replace with an API adapter when backend work begins. */
export const prototypeRepository = {
  load(): { data: PrototypeData; warning?: string } {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return { data: prepareData(createDemoData()) }
      const parsed: unknown = JSON.parse(raw)
      if (!isData(parsed)) return { data: prepareData(createDemoData()), warning: 'Сохранённые данные не удалось прочитать. Показан демонабор; исходная запись не удалена.' }
      return { data: prepareData(parsed) }
    } catch {
      return { data: prepareData(createDemoData()), warning: 'Хранилище браузера недоступно. Изменения будут доступны только до перезагрузки.' }
    }
  },
  save(data: PrototypeData): boolean {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); return true } catch { return false }
  },
}
