import { useState } from 'react'
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { depositTypeLabel } from './AccountGroups'
import { DepositHistoryPanel } from './DepositHistoryViews'
import { depositMovements } from './depositCalculations'
import { OperationRows } from './OperationRows'
import { formatMoney, type Account, type Operation, type Snapshot } from './client'

export type DepositTab = 'overview' | 'savings' | 'history'
export interface TransferPreset { kind: 'transfer'; account_id: string; destination_account_id: string }
export function depositTransfer(data: Snapshot, deposit: Account, action: 'add' | 'withdraw'): TransferPreset | null {
  if (deposit.archived) return null
  const candidates = data.accounts.filter(a => a.id !== deposit.id && !a.archived && a.currency === deposit.currency)
  const other = candidates.find(a => a.kind !== 'deposit') ?? candidates[0]
  if (!other) return null
  return { kind: 'transfer', account_id: action === 'add' ? other.id : deposit.id, destination_account_id: action === 'add' ? deposit.id : other.id }
}
export function depositOperations(data: Snapshot, account: Account) {
  return data.operations.filter(op => op.currency === account.currency && (op.account_id === account.id || (op.kind === 'transfer' && op.destination_account_id === account.id)))
    .sort((a, b) => b.occurred_on.localeCompare(a.occurred_on))
}

export function DepositDetails({ account, data, initialTab = 'overview', onTransfer, onOperation, onEdit }: {
  account: Account; data: Snapshot; initialTab?: DepositTab; onTransfer: (preset: TransferPreset) => void; onOperation: (op: Operation) => void; onEdit: () => void
}) {
  const [tab, setTab] = useState<DepositTab>(initialTab)
  const flows = depositMovements(account, data.operations, data.categories, data.as_of)
  const add = depositTransfer(data, account, 'add'), withdraw = depositTransfer(data, account, 'withdraw')
  const tabs = [['overview', 'Обзор'], ['savings', 'Накопления'], ['history', 'История']] as const
  const transfers = <div className="deposit-transfer-actions"><button className="button primary" disabled={!add} onClick={() => add && onTransfer(add)}><ArrowDownLeft size={16} />Пополнить</button><button className="button secondary" disabled={!withdraw} onClick={() => withdraw && onTransfer(withdraw)}><ArrowUpRight size={16} />Снять</button></div>
  const totals = <dl className="detail-list deposit-flow-totals"><div><dt>Всего пополнено</dt><dd>{formatMoney(flows.added, account.currency)}</dd></div><div><dt>Всего снято</dt><dd>{formatMoney(flows.withdrawn, account.currency)}</dd></div></dl>
  return <div className="deposit-details">
    <div className="deposit-tabs" role="tablist" aria-label="Разделы депозита">{tabs.map(([key, label]) => <button key={key} id={`deposit-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls="deposit-tab-content" tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)} onKeyDown={e => {
      const index = tabs.findIndex(([value]) => value === key)
      const next = e.key === 'ArrowRight' ? (index + 1) % tabs.length : e.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null
      if (next !== null) { e.preventDefault(); setTab(tabs[next][0]); (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus() }
    }}>{label}</button>)}</div>
    <section id="deposit-tab-content" role="tabpanel" aria-labelledby={`deposit-tab-${tab}`} className="deposit-tab-content">
      {tab !== 'history' && <><div className="detail-hero deposit-hero"><span>{account.bank_code || 'Банк не указан'} · {depositTypeLabel(account)}{account.archived ? ' · архив' : ''}</span><strong>{formatMoney(account.balance_minor, account.currency)}</strong><span>Текущий остаток</span></div>{transfers}
        {!add && <p className="ledger-hint">{account.archived ? 'Депозит в архиве.' : `Для перевода добавьте другой активный счёт в ${account.currency}.`}</p>}
      </>}
      {tab === 'overview' && <><div className="deposit-insights"><DepositHistoryPanel account={account} data={data} /></div>{totals}</>}
      {tab === 'savings' && <>{totals}<p className="ledger-hint">Пополнения и снятия — переводы между вашими счетами.</p></>}
      {tab === 'history' && <OperationRows items={depositOperations(data, account)} data={data} accountId={account.id} onSelect={onOperation} />}
    </section>
    <div className="modal-actions"><button className="button secondary" onClick={onEdit}>Изменить депозит</button></div>
  </div>
}
