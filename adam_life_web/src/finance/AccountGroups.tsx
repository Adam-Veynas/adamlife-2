import { Banknote, CreditCard, Landmark } from 'lucide-react'
import { formatMoney, type Account, type Currency } from './client'

export const depositTypeLabel = (account: Account) => account.deposit_type === 'term' ? 'Срочный' : account.deposit_type === 'savings' ? 'Накопительный' : 'Тип не указан'
export function accountGroups(accounts: Account[], currency: Currency) {
  const selected = accounts.filter(a => a.currency === currency)
  return { regular: selected.filter(a => a.kind !== 'deposit'), deposits: selected.filter(a => a.kind === 'deposit') }
}
export function AccountGroups({ accounts, currency, onOpen, onAdd }: { accounts: Account[]; currency: Currency; onOpen: (account: Account) => void; onAdd: (kind: 'bank' | 'deposit') => void }) {
  const groups = accountGroups(accounts, currency)
  return <div className="ledger-account-groups">{(['regular', 'deposits'] as const).map(group => <section className={`accounts-section account-group-${group}`} key={group}>
    <div className="panel-heading"><h2>{group === 'regular' ? 'Мои счета' : 'Депозиты'} · {currency}</h2><button className="text-action" onClick={() => onAdd(group === 'regular' ? 'bank' : 'deposit')}>Добавить {group === 'regular' ? 'счёт' : 'депозит'}</button></div>
    <div className="account-grid">{groups[group].map(a => <button className={`account-card ${a.kind === 'deposit' ? 'deposit-account-card' : ''}`} key={a.id} onClick={() => onOpen(a)}>
      <span className="account-symbol">{a.kind === 'deposit' ? <Landmark size={19} /> : a.kind === 'cash' ? <Banknote size={19} /> : <CreditCard size={19} />}</span>
      <span className="account-card-name">{a.name}{a.archived ? ' · архив' : ''}</span>
      {a.kind === 'deposit' && <small>{a.bank_code || 'Банк не указан'} · {depositTypeLabel(a)}</small>}
      <strong>{formatMoney(a.balance_minor, a.currency)}</strong>
    </button>)}</div>
    {!groups[group].length && <p className="small-empty">{group === 'regular' ? 'Нет обычных счетов' : 'Нет депозитов'} в {currency}.</p>}
  </section>)}</div>
}
