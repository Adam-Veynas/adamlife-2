import { demoImportRows, localDate, type AccountId, type Transaction } from './finance'

export type ImportChoice = 'include' | 'exclude' | 'duplicate' | 'review'
export interface ImportRow { transaction: Transaction; choice: ImportChoice; ambiguous: boolean; duplicate?: Transaction }
/** Fixture adapter only. A future parser can return the same review model. Never reads a PDF. */
export function createImportExample(accountId: Exclude<AccountId, 'cash'>, month: Date, existing: Transaction[]): ImportRow[] {
  const examples: Transaction[] = demoImportRows(month).map(row => ({ ...row, accountId, id: accountId === 'kaspi' ? row.id : `freedom-${row.id}` }))
  examples.push({ id: `${accountId}-example-review`, type: 'expense', amountMinor: 780000, date: localDate(new Date(month.getFullYear(), month.getMonth(), 19)), category: 'Другое', comment: 'Перевод продавцу · назначение уточнить', source: 'demo-import', accountId })
  const overlap = existing.find(row => row.type === 'expense' && (row.accountId ?? 'kaspi') === accountId)
  if (overlap && !examples.some(row => row.id === overlap.id)) examples.push(overlap)
  return examples.map(transaction => {
    // Only a stable identical fixture ID proves a duplicate here. Amount/date alone never do.
    const duplicate = existing.find(row => row.id === transaction.id)
    const ambiguous = transaction.id.endsWith('example-review')
    return { transaction, duplicate, ambiguous, choice: duplicate ? 'duplicate' : ambiguous ? 'review' : 'include' }
  })
}
export function importOutcome(rows: ImportRow[], existingIds: Set<string>) {
  const result = { accepted: 0, excluded: 0, duplicates: 0, review: 0, transactions: [] as Transaction[] }
  const seen = new Set(existingIds)
  for (const row of rows) {
    if (row.choice === 'exclude') { result.excluded++; continue }
    if (row.choice === 'duplicate' || seen.has(row.transaction.id)) { result.duplicates++; continue }
    if (row.choice === 'review') { result.review++; continue }
    result.accepted++; result.transactions.push(row.transaction); seen.add(row.transaction.id)
  }
  return result
}
