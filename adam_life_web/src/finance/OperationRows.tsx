import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight } from 'lucide-react'
import { movement, type Operation, type Snapshot } from './client'

export function operationDirection(row: Operation, accounts: Snapshot['accounts']) {
  const name = (id: string | null) => accounts.find(a => a.id === id)?.name ?? 'Счёт'
  return row.kind === 'transfer' ? `${name(row.account_id)} → ${name(row.destination_account_id)}` : name(row.account_id)
}

export function OperationRows({ items, data, accountId = '', onSelect }: {
  items: Operation[]; data: Snapshot; accountId?: string; onSelect: (item: Operation) => void
}) {
  if (!items.length) return <p className="small-empty">Операций пока нет.</p>
  return <div className="ledger-operation-list">{items.map(row => {
    const Icon = row.kind === 'transfer' ? ArrowLeftRight : row.kind === 'income' ? ArrowDownLeft : ArrowUpRight
    const title = row.adjustment_type ? ({ refund: 'Возврат покупки', reversal: 'Отмена операции', fx: 'Курсовая корректировка', return_funds: 'Возврат средств' })[row.adjustment_type] : row.kind === 'transfer' ? 'Перевод' : data.categories.find(c => c.id === row.category_id)?.name ?? (row.kind === 'income' ? 'Доход' : 'Расход')
    return <button key={row.id} className={`ledger-row operation-${row.adjustment_type ? 'transfer' : row.kind}`} onClick={() => onSelect(row)}>
      <span className="account-symbol operation-icon"><Icon size={18} /></span>
      <span className="ledger-row-copy"><strong>{title}</strong>{row.adjustment_pending && <small>Связь не подтверждена · требуется проверка</small>}<small>{operationDirection(row, data.accounts)}</small><small>{row.occurred_on.split('-').reverse().join('.')}{row.comment ? ` · ${row.comment}` : ''}</small></span>
      <strong className="operation-amount">{movement(row, accountId)}</strong>
    </button>
  })}</div>
}
