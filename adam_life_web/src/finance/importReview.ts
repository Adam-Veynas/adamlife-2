import { FinanceError, type Category } from './client'

export interface ReviewableRow {
  index: number; signed_minor: string; kind: string; status: string; own_hint: boolean
  candidates: unknown[]
}
export interface ImportChoice {
  index: number; action?: string; kind?: string; category_id?: string; other_account_id?: string
  match_id?: string; related_id?: string; reviewed?: boolean; remember_category?: boolean; remember_account?: boolean
}
export type ImportFilter = 'all' | 'defined' | 'review' | 'duplicates'
export function filterImportRows<T extends ReviewableRow>(rows: T[], filter: ImportFilter) {
  return rows.filter(row => filter === 'all' || (filter === 'defined' ? row.status === 'new' : filter === 'duplicates' ? row.status === 'duplicate' : ['review', 'before_opening'].includes(row.status)))
}
// Ambiguous ownership, corrections and ledger matches must be inspected individually.
export function canBulkReview(row: ReviewableRow, choice?: ImportChoice) {
  return ['income', 'expense'].includes(row.kind) && ['income', 'expense'].includes(choice?.kind ?? row.kind)
    && !row.own_hint && !row.candidates.length && !['duplicate', 'before_opening'].includes(row.status)
    && (!choice?.action || choice.action === 'add')
}
export function bulkReview(rows: ReviewableRow[], selected: number[], current: Record<number, ImportChoice>, category?: Category, remember = false) {
  const next = { ...current }
  for (const index of selected) {
    const row = rows.find(row => row.index === index)
    if (!row || !canBulkReview(row, current[index])) throw new Error('Переводы, возвраты, совпадения и начало учёта проверяются отдельно.')
    if (category && (category.archived || category.kind !== (BigInt(row.signed_minor) > 0n ? 'income' : 'expense'))) throw new Error('Выберите операции одного типа и подходящую категорию.')
    next[index] = { ...next[index], index, reviewed: true, ...(category ? { category_id: category.id, remember_category: remember } : {}) }
  }
  return next
}

export async function uploadPDF<T>(file: Blob, csrf: string): Promise<T> {
  if (file.size > 5 * 1024 * 1024) throw new Error('Размер PDF не должен превышать 5 МБ.')
  let bytes: ArrayBuffer
  try { bytes = await file.arrayBuffer() } catch { throw new Error('Не удалось прочитать файл с устройства. Сохраните его в «Файлы» и выберите снова.') }
  if (!bytes.byteLength || bytes.byteLength !== file.size) throw new Error('Файл прочитан не полностью. Выберите сохранённый на устройстве PDF снова.')
  if (String.fromCharCode(...new Uint8Array(bytes, 0, Math.min(5, bytes.byteLength))) !== '%PDF-') throw new Error('Содержимое файла не является PDF.')
  let response: Response
  try {
    // Materialise Safari/iCloud File before sending, rather than relying on a live File handle.
    response = await fetch('/api/finance/imports/kaspi', { method: 'POST', credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/pdf', 'X-CSRF-Token': csrf }, body: bytes, signal: AbortSignal.timeout(70000) })
  } catch { throw new Error('Нет ответа сервера при загрузке. Проверьте соединение и повторите выбор PDF.') }
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new FinanceError(response.status, payload?.error?.message ?? 'Сервер не смог обработать загрузку. Попробуйте позже.')
  if (!payload || typeof payload.id !== 'string') throw new Error('Получен неполный ответ сервера. Повторите загрузку.')
  return payload as T
}
