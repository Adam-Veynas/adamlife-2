import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Modal } from '../components/Dialogs'
import { Editor, Confirm } from './Editors'
import { amountText, formatMoney, parseMinor, type Currency, type Snapshot } from './client'
import { goalFunding, goalHasDeficit, useSavingsResource, type Goal, type Savings, type SavingsAccount } from './savingsClient'

const statusLabel = { active: 'Активна', completed: 'Завершена', archived: 'В архиве' }
const dateLabel = (date: string) => date.split('-').reverse().join('.')
type Save = (path: string, method: string, body: unknown) => Promise<void>

function GoalEditor({ goal, state, save, close }: { goal?: Goal; state: Savings; save: Save; close: () => void }) {
  const [name, setName] = useState(goal?.name ?? ''), [target, setTarget] = useState(goal ? amountText(goal.target_minor) : '')
  const [currency, setCurrency] = useState<Currency>(goal?.currency ?? 'KZT'), [deadline, setDeadline] = useState(goal?.deadline ?? '')
  const [mode, setMode] = useState<Goal['mode']>(goal?.mode ?? 'linked'), [manual, setManual] = useState(amountText(goal?.manual_minor ?? '0'))
  const [allocations, setAllocations] = useState<Record<string, string>>(Object.fromEntries(goal?.allocations.map(a => [a.account_id, amountText(a.amount_minor)]) ?? []))
  const accounts = state.accounts.filter(a => a.currency === currency && (!a.archived || goal?.allocations.some(item => item.account_id === a.id)))
  return <Editor title={goal ? 'Изменить цель' : 'Новая цель'} onClose={close} submit={() => save('goals' + (goal ? '/' + goal.id : ''), goal ? 'PUT' : 'POST', {
    name, target_minor: parseMinor(target), currency, deadline: deadline || null, mode, expected_version: goal?.version,
    ...goalFunding(mode, manual, allocations),
  })}>
    <label className="field"><span>Название</span><input required maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="Например, автомобиль" /></label>
    <div className="form-grid"><label className="field"><span>Целевая сумма</span><input required inputMode="decimal" value={target} onChange={e => setTarget(e.target.value)} /></label><label className="field"><span>Валюта</span><select disabled={!!goal} value={currency} onChange={e => { setCurrency(e.target.value as Currency); setAllocations({}) }}>{['KZT', 'USD', 'EUR'].map(c => <option key={c}>{c}</option>)}</select></label></div>
    <label className="field"><span>Желаемая дата · необязательно</span><input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} /></label>
    <label className="field"><span>Как учитывать прогресс</span><select value={mode} onChange={e => setMode(e.target.value as Goal['mode'])}><option value="linked">Распределение со своих счетов</option><option value="manual">Ручной прогресс · без счетов</option></select></label>
    {goal && mode !== goal.mode && <p className="savings-warning">Смена режима заменит прежний прогресс. Распределения по счетам будут освобождены при переходе на ручной учёт.</p>}
    {mode === 'manual' ? <><label className="field"><span>Накоплено вручную</span><input required inputMode="decimal" value={manual} onChange={e => setManual(e.target.value)} /></label><p className="ledger-hint">Отдельный показатель прогресса. Не является деньгами на счёте и не входит в финансовый баланс.</p></> : <>
      <p className="ledger-hint">Укажите, сколько выделить из каждого счёта. Это распределение уже имеющихся средств, без списания денег. Пустое поле или 0 освобождает средства.</p>
      {accounts.map(account => <div className="savings-allocation" key={account.id}><label className="field"><span>{account.name}{account.archived ? ' · архив' : ''} · {currency}</span><input inputMode="decimal" value={allocations[account.id] ?? ''} placeholder="0" onChange={e => setAllocations({ ...allocations, [account.id]: e.target.value })} /></label><AccountFunds account={account} />{account.archived && <p className="ledger-hint">Можно уменьшить сумму до 0 и распределить средства с другого активного счёта.</p>}</div>)}
      {!accounts.length && <p className="ledger-hint">Нет счетов в {currency}. Цель можно сохранить без распределений или выбрать ручной прогресс.</p>}
    </>}
  </Editor>
}

function AccountFunds({ account }: { account: SavingsAccount }) {
  return <><p className="ledger-hint">Остаток: {formatMoney(account.balance_minor, account.currency)} · Выделено всем целям: {formatMoney(account.allocated_minor, account.currency)} · Свободно: {formatMoney(account.free_minor, account.currency)}</p>
    {BigInt(account.deficit_minor) > 0n && <p className="savings-warning" role="status">Дефицит распределений: {formatMoney(account.deficit_minor, account.currency)}. Уменьшите выделенные суммы или пополните счёт. Прогресс сохранён, но часть средств не обеспечена остатком.</p>}</>
}
function GoalProgress({ goal }: { goal: Goal }) {
  return <div className="savings-progress"><div><strong>{formatMoney(goal.collected_minor, goal.currency)}</strong><span>{goal.percent}%</span></div><progress aria-label={`Выполнение цели ${goal.name}`} value={goal.percent} max={100} /><p className="ledger-hint">из {formatMoney(goal.target_minor, goal.currency)} · Осталось {formatMoney(goal.remaining_minor, goal.currency)}</p></div>
}

export function SavingsGoals({ csrf, ledger, onUnauthorized }: { csrf: string; ledger: Snapshot; onUnauthorized: () => void }) {
  const resource = useSavingsResource<Savings>('savings', csrf, ledger, onUnauthorized)
  const [editor, setEditor] = useState<string | 'new' | null>(null), [detail, setDetail] = useState<string | null>(null), [archive, setArchive] = useState(false)
  const [change, setChange] = useState<{ goal: Goal; status: Goal['status'] } | null>(null)
  const state = resource.data, goal = state?.goals.find(g => g.id === detail)
  return <section className="savings-section">
    <div className="panel-heading"><h2>Цели накопления</h2><button className="button primary" disabled={!state || resource.loading} onClick={() => setEditor('new')}><Plus size={16} />Создать цель</button></div>
    <p className="ledger-hint">Распределяйте существующие средства между целями. Балансы счетов остаются прежними.</p>
    <label className="ledger-check"><input type="checkbox" checked={archive} onChange={e => setArchive(e.target.checked)} />Показать архив</label>
    {resource.loading && <p role="status">Загружаем цели…</p>}{resource.error && <p className="form-error" role="alert">{resource.error} <button className="text-action" onClick={() => void resource.reload()}>Повторить</button></p>}
    {state && <>
      {state.accounts.filter(a => BigInt(a.deficit_minor) > 0n).map(a => <aside className="savings-allocation" key={a.id}><strong>{a.name}</strong><AccountFunds account={a} /><p className="ledger-hint">Откройте связанную цель → «Изменить», чтобы скорректировать распределение.</p></aside>)}
      <div className="savings-grid">{state.goals.filter(g => archive || g.status !== 'archived').map(g => <article className="panel savings-card" key={g.id}><div className="panel-heading"><h3>{g.name}</h3><span className="ledger-hint">{statusLabel[g.status]}</span></div><GoalProgress goal={g} /><p className="ledger-hint">{g.mode === 'manual' ? 'Ручной прогресс · вне финансового баланса' : g.status === 'archived' ? 'Прогресс на момент архивации · средства освобождены' : 'Распределено со счетов'}{g.deadline ? ` · До ${dateLabel(g.deadline)}` : ''}</p>{g.overdue && <p className="savings-warning">Желаемая дата прошла. Обновите срок или продолжайте накопление.</p>}{goalHasDeficit(g, state.accounts) && <p className="savings-warning">Есть дефицит на связанном счёте</p>}<button className="text-action" onClick={() => setDetail(g.id)}>Подробнее</button></article>)}</div>
      {!state.goals.some(g => archive || g.status !== 'archived') && <p className="small-empty">Пока нет целей. Создайте первую, когда будете готовы.</p>}
    </>}
    {goal && state && !editor && !change && <Modal title={goal.name} onClose={() => setDetail(null)}><div className="savings-section"><GoalProgress goal={goal} /><dl className="detail-list"><div><dt>Статус</dt><dd>{statusLabel[goal.status]}</dd></div>{goal.deadline && <div><dt>Желаемая дата</dt><dd>{dateLabel(goal.deadline)}</dd></div>}{goal.monthly_minor !== null && <div><dt>Откладывать в месяц</dt><dd>{formatMoney(goal.monthly_minor, goal.currency)}</dd></div>}</dl>
      {goal.monthly_minor !== null && <p className="ledger-hint">Остаток цели разделён на календарные месяцы, включая текущий и месяц достижения. Округлено вверх до минимальной денежной единицы.</p>}
      {goal.overdue && <p className="savings-warning">Срок прошёл. Ежемесячный расчёт недоступен до выбора новой даты.</p>}
      {goal.mode === 'manual' && <p className="ledger-hint">Ручной прогресс, без привязки к счетам. Не входит в общий баланс.</p>}
      {goal.status === 'archived' && <p className="ledger-hint">Показан прогресс на момент архивации. Распределения освобождены; после восстановления их нужно назначить заново.</p>}
      {goal.allocations.map(a => { const account = state.accounts.find(item => item.id === a.account_id); return account && <div className="savings-allocation" key={a.account_id}><strong>{account.name}{account.archived ? ' · архив' : ''}: {formatMoney(a.amount_minor, goal.currency)}</strong><AccountFunds account={account} />{account.archived && <p className="ledger-hint">Нажмите «Изменить», уменьшите выделенную сумму и выберите другой счёт.</p>}</div> })}
      {goal.status === 'completed' && <p className="ledger-hint">Средства остаются выделенными. Архивация освободит их для других целей.</p>}
      <div className="modal-actions savings-actions">{goal.status === 'active' ? <><button className="button secondary" onClick={() => setEditor(goal.id)}>Изменить</button><button className="button primary" disabled={goal.remaining_minor !== '0' || goalHasDeficit(goal, state.accounts)} onClick={() => setChange({ goal, status: 'completed' })}>Завершить</button></> : <button className="button secondary" onClick={() => setChange({ goal, status: 'active' })}>Вернуть в активные</button>}{goal.status !== 'archived' && <button className="text-action" onClick={() => setChange({ goal, status: 'archived' })}>В архив</button>}</div>
    </div></Modal>}
    {editor && state && <GoalEditor key={editor + ':' + (state.goals.find(g => g.id === editor)?.version ?? 0)} goal={state.goals.find(g => g.id === editor)} state={state} save={resource.save} close={() => setEditor(null)} />}
    {change && <Confirm title={change.status === 'archived' ? 'Архивировать цель?' : change.status === 'completed' ? 'Завершить цель?' : 'Вернуть цель в активные?'} description={change.status === 'archived' ? 'Распределённые средства будут освобождены. Прогресс на момент архивации и изменения сохранятся. Реальные балансы не изменятся.' : change.status === 'completed' ? 'Средства останутся выделенными этой цели до её архивации или изменения.' : 'Для архивной цели распределения нужно назначить заново. Ручной прогресс сохранится.'} onClose={() => setChange(null)} action={() => resource.save(`goals/${change.goal.id}/status`, 'POST', { status: change.status, expected_version: change.goal.version })} />}
  </section>
}
