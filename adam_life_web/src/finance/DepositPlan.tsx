import { useState, type FormEvent } from 'react'
import { amountText, formatMoney, parseMinor, type Account, type Snapshot } from './client'
import { useSavingsResource, type Plan } from './savingsClient'

export function DepositPlan({ account, ledger, csrf, onUnauthorized }: { account: Account; ledger: Snapshot; csrf: string; onUnauthorized: () => void }) {
  const resource = useSavingsResource<Plan>('deposit-plans/' + account.id, csrf, ledger, onUnauthorized)
  const [editing, setEditing] = useState(false), [amount, setAmount] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const plan = resource.data
  const money = (value: string) => formatMoney(value, account.currency)
  const month = (date: string) => `${date.slice(5, 7)}.${date.slice(0, 4)}`
  async function save(disable: boolean, event?: FormEvent) {
    event?.preventDefault()
    if (!plan || busy) return
    setBusy(true); setError('')
    try { await resource.save('deposit-plans/' + account.id, 'PUT', { amount_minor: disable ? null : parseMinor(amount), expected_revision: plan.revision }); setEditing(false) }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить план') }
    finally { setBusy(false) }
  }
  return <section className="savings-section deposit-plan"><h3>Ежемесячное пополнение</h3><p className="ledger-hint">Личный ориентир. Деньги автоматически не переводятся. В факте — только входящие переводы со своих счетов.</p>
    {resource.loading && <p role="status">Загружаем план…</p>}{resource.error && <p className="form-error" role="alert">{resource.error} <button className="text-action" onClick={() => void resource.reload()}>Повторить</button></p>}
    {plan && <><dl className="detail-list"><div><dt>План · {month(plan.current.month)}</dt><dd>{plan.current.target_minor === null ? 'Отключён' : money(plan.current.target_minor)}</dd></div><div><dt>Пополнено за месяц</dt><dd>{money(plan.current.actual_minor)}</dd></div>{plan.current.remaining_minor !== null && <div><dt>Осталось пополнить</dt><dd>{money(plan.current.remaining_minor)}</dd></div>}</dl>
      {plan.current.percent !== null && <div className="savings-progress"><span>Выполнено {plan.current.percent}%</span><progress aria-label="Выполнение месячного плана" max={100} value={plan.current.percent} /></div>}
      {!editing && <div className="savings-actions">{!account.archived && <button className="button secondary" disabled={busy} onClick={() => { setAmount(amountText(plan.current.target_minor ?? '0')); setError(''); setEditing(true) }}>{plan.current.target_minor === null ? 'Включить план' : 'Изменить план'}</button>}{plan.current.target_minor !== null && <button className="text-action" disabled={busy} onClick={() => void save(true)}>Отключить план</button>}</div>}
      {editing && <form className="savings-section" onSubmit={e => void save(false, e)}><label className="field"><span>Сумма в месяц · {account.currency}</span><input required disabled={busy} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} /></label><p className="ledger-hint">Изменение действует с текущего месяца. Планы прошлых месяцев сохраняются.</p><div className="savings-actions"><button className="button primary" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button><button type="button" className="button secondary" disabled={busy} onClick={() => setEditing(false)}>Отмена</button></div></form>}
      {plan.revision > 0 && <details className="deposit-extra"><summary>История плана по месяцам</summary><div className="savings-section">{plan.history.map(row => <div className="savings-allocation" key={row.month}><strong>{month(row.month)}</strong><dl className="detail-list"><div><dt>План</dt><dd>{row.target_minor === null ? 'Отключён' : money(row.target_minor)}</dd></div><div><dt>Факт</dt><dd>{money(row.actual_minor)}</dd></div></dl></div>)}</div></details>}
    </>}{error && <p className="form-error" role="alert">{error}</p>}
  </section>
}
