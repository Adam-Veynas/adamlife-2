import { useState } from 'react'
import { BalanceHistoryChart } from '../components/Charts'
import { localDate } from '../domain/finance'
import { formatMoney, type Account, type Snapshot } from './client'
import type { DepositPeriod } from './depositCalculations'
import { compareDeposits, depositHistory, depositTerm } from './depositHistory'

function PeriodSelect({ value, onChange, label }: { value: DepositPeriod; onChange: (v: DepositPeriod) => void; label: string }) {
  return <label className="field deposit-period"><span>{label}</span><select value={value} onChange={e => onChange(Number(e.target.value) as DepositPeriod)}><option value={3}>3 месяца</option><option value={6}>6 месяцев</option><option value={12}>12 месяцев</option></select></label>
}
const dateLabel = (date: string) => date.split('-').reverse().join('.')

export function DepositHistoryPanel({ account, data }: { account: Account; data: Snapshot }) {
  const [months, setMonths] = useState<DepositPeriod>(3)
  const history = depositHistory(account, data.operations, data.as_of, months)
  const term = depositTerm(account.deposit_ends_on, localDate(new Date()))
  return <>
    {term && <section className="deposit-term"><h3>{term.status}</h3><p>Окончание: {dateLabel(term.end)}</p><p>{term.days < 0 ? `Срок истёк ${-term.days} дн. назад` : term.days === 0 ? 'Заканчивается сегодня' : `До окончания: ${term.days} дн.`}</p></section>}
    <section><h3>Фактический остаток</h3><PeriodSelect label="Период графика" value={months} onChange={setMonths} />
      {history?.points.length ? <BalanceHistoryChart key={months} points={history.points} format={amount => formatMoney(amount, account.currency)} /> : <p className="ledger-hint">История появится с даты начала учёта.</p>}
      <p className="ledger-hint">На конец месяца · текущий месяц по {dateLabel(data.as_of)}.</p>
    </section>
  </>
}

export function DepositComparison({ data }: { data: Snapshot }) {
  const [months, setMonths] = useState<DepositPeriod>(3)
  const groups = compareDeposits(data.accounts, data.operations, data.as_of, months)
  if (!groups.length) return null
  return <details className="panel deposit-comparison"><summary>Сравнить депозиты ({groups.reduce((n, g) => n + g.rows.length, 0)})</summary>
    <PeriodSelect label="Период изменения остатка" value={months} onChange={setMonths} />
    <p className="ledger-hint">Пополнения и снятия — за всё время. Изменение — за выбранный период, включая начальный остаток для новых депозитов.</p>
    {groups.map(group => <section key={group.currency}><h3>{group.currency}</h3><div className="deposit-comparison-list">{group.rows.map(({ account, history }) => <article key={account.id}>
      <h4>{account.name}{account.archived ? ' · архив' : ''}</h4><p className="ledger-hint">{account.bank_code || 'Банк не указан'} · {account.currency}</p>
      <dl className="detail-list"><div><dt>Текущий остаток</dt><dd>{formatMoney(account.balance_minor, account.currency)}</dd></div><div><dt>Пополнено переводами</dt><dd>{history ? formatMoney(history.added, account.currency) : 'Нет данных'}</dd></div><div><dt>Снято переводами</dt><dd>{history ? formatMoney(history.withdrawn, account.currency) : 'Нет данных'}</dd></div><div><dt>Изменение за период</dt><dd>{history ? `${history.change > 0n ? '+' : ''}${formatMoney(history.change, account.currency)}` : 'Нет данных'}</dd></div>{account.deposit_ends_on && <div><dt>Окончание</dt><dd>{dateLabel(account.deposit_ends_on)}</dd></div>}</dl>
    </article>)}</div></section>)}
  </details>
}
