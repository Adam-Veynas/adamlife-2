import { useState, type FormEvent, type ReactNode } from 'react'
import { Modal } from '../components/Dialogs'
import { localDate } from '../domain/finance'
import { formatMoney, amountText, parseMinor, depositEditorValues, type DepositType, type Account, type Category, type Kind, type Operation, type Snapshot } from './client'

import type { TransferPreset } from './DepositDetails'

type Save = (path: string, method: string, body: unknown) => Promise<void>
export function Editor({ title, children, onClose, submit }: { title: string; children: ReactNode; onClose: () => void; submit: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function save(event: FormEvent) { event.preventDefault(); if (busy) return; setBusy(true); setError(''); try { await submit(); onClose() } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить'); setBusy(false) } }
  return <Modal title={title} onClose={() => { if (!busy) onClose() }}><form className="transaction-form" onSubmit={save}><fieldset disabled={busy} className="ledger-fields">{children}</fieldset>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" disabled={busy} className="button secondary" onClick={onClose}>Отмена</button><button className="button primary" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button></div></form></Modal>
}
export function AccountEditor({ item, initialKind = 'bank', onSave, onClose }: { item?: Account; initialKind?: Account['kind']; onSave: Save; onClose: () => void }) {
  const [name, setName] = useState(item?.name ?? ''), [kind, setKind] = useState(item?.kind ?? initialKind), [bank, setBank] = useState(item?.bank_code ?? '')
  const [currency, setCurrency] = useState(item?.currency ?? 'KZT'), [opening, setOpening] = useState(item ? amountText(item.opening_balance_minor) : '0')
  const [date, setDate] = useState(item?.opening_date ?? localDate(new Date())), [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false)
  const [depositType, setDepositType] = useState<DepositType>(item?.deposit_type ?? 'savings')
  const [opened, setOpened] = useState(item?.deposit_opened_on ?? ''), [ends, setEnds] = useState(item?.deposit_ends_on ?? '')
  const baselineChanged = !!item && (opening !== amountText(item.opening_balance_minor) || date !== item.opening_date)
  return <Editor title={item ? 'Редактировать счёт' : 'Новый счёт'} onClose={onClose} submit={async () => {
    if (baselineChanged && !confirmed) throw new Error('Подтвердите изменение начального остатка')
    await onSave('accounts' + (item ? '/' + item.id : ''), item ? 'PUT' : 'POST', { name, kind, bank_code: kind === 'cash' ? null : bank || null, currency,
      opening_balance_minor: parseMinor(opening, true), opening_date: date, archived: item?.archived ?? false, expected_version: item?.version, opening_change_reason: baselineChanged ? reason : null,
      ...depositEditorValues(kind, depositType, opened, ends) })
  }}>
    <label className="field"><span>Название</span><input required maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="Например, основная карта" /></label>
    <div className="form-grid"><label className="field"><span>Тип счёта</span><select value={kind} onChange={e => setKind(e.target.value as Account['kind'])}><option value="bank">Банковский счёт / карта</option><option value="cash">Наличные</option><option value="deposit">Депозит</option></select></label>
      <label className="field"><span>Валюта</span><select disabled={!!item} value={currency} onChange={e => setCurrency(e.target.value as Account['currency'])}>{['KZT', 'USD', 'EUR'].map(v => <option key={v}>{v}</option>)}</select></label></div>
    {kind !== 'cash' && <label className="field"><span>Банк · необязательно</span><input maxLength={40} value={bank} onChange={e => setBank(e.target.value)} /></label>}
    {kind === 'deposit' && <>
      <div className="form-grid"><label className="field"><span>Тип депозита</span><select required value={depositType} onChange={e => setDepositType(e.target.value as DepositType)}><option value="savings">Накопительный</option><option value="term">Срочный</option></select></label>
        <label className="field"><span>Дата окончания · необязательно</span><input type="date" min={opened || undefined} value={ends} onChange={e => setEnds(e.target.value)} /></label></div>
      {!item && <label className="field"><span>Начальный баланс</span><input required inputMode="decimal" value={opening} onChange={e => setOpening(e.target.value)} /></label>}
      <details className="deposit-extra accounting-settings"><summary>Параметры учёта</summary><div className="ledger-fields">
        {item && <label className="field"><span>Начальный баланс</span><input required inputMode="decimal" value={opening} onChange={e => setOpening(e.target.value)} /></label>}
        <label className="field"><span>Дата начала учёта</span><input required type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label className="field"><span>Дата открытия · необязательно</span><input type="date" value={opened} onChange={e => setOpened(e.target.value)} /></label>
        <p className="ledger-hint">Начальный баланс — остаток до операций даты начала учёта.</p>
      </div></details>
    </>}
    {kind !== 'deposit' && <><div className="form-grid"><label className="field"><span>Начальный баланс</span><input required inputMode="decimal" value={opening} onChange={e => setOpening(e.target.value)} /></label>
      <label className="field"><span>Дата начала учёта</span><input required type="date" value={date} onChange={e => setDate(e.target.value)} /></label></div>
    <p className="ledger-hint">Начальный баланс — остаток на начало выбранного дня. Операции этого дня и позже учитываются отдельно. Ранее этой даты операции добавить нельзя.</p></>}
    {baselineChanged && <><label className="field"><span>Причина корректировки</span><textarea required maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label><label className="ledger-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Подтверждаю пересчёт баланса. Корректировка останется в истории аудита.</label></>}
  </Editor>
}
export function CategoryEditor({ item, onSave, onClose }: { item?: Category; onSave: Save; onClose: () => void }) {
  const [name, setName] = useState(item?.name ?? ''), [kind, setKind] = useState(item?.kind ?? 'expense')
  return <Editor title={item ? 'Редактировать категорию' : 'Новая категория'} onClose={onClose} submit={() => onSave('categories' + (item ? '/' + item.id : ''), item ? 'PUT' : 'POST', { name, kind, archived: item?.archived ?? false, expected_version: item?.version })}>
    <label className="field"><span>Название</span><input required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
    <label className="field"><span>Тип</span><select disabled={!!item} value={kind} onChange={e => setKind(e.target.value as Category['kind'])}><option value="expense">Расход</option><option value="income">Доход</option></select></label>
  </Editor>
}
export function OperationEditor({ item, preset, data, onSave, onClose }: { item?: Operation; preset?: TransferPreset; data: Snapshot; onSave: Save; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>(item?.kind ?? preset?.kind ?? 'expense'), [amount, setAmount] = useState(item ? amountText(item.amount_minor) : '')
  const [account, setAccount] = useState(item?.account_id ?? preset?.account_id ?? data.accounts.find(a => !a.archived)?.id ?? ''), [destination, setDestination] = useState(item?.destination_account_id ?? preset?.destination_account_id ?? '')
  const [category, setCategory] = useState(item?.category_id ?? data.categories.find(c => c.kind === 'expense' && !c.archived)?.id ?? '')
  const [date, setDate] = useState(item?.occurred_on ?? localDate(new Date())), [comment, setComment] = useState(item?.comment ?? '')
  const [adjustment, setAdjustment] = useState<Operation['adjustment_type']>(item?.adjustment_type ?? null)
  const [related, setRelated] = useState(item?.related_transaction_id ?? '')
  const selected = data.accounts.find(a => a.id === account)
  const options = (target = false) => data.accounts.filter(a => (!a.archived || a.id === (target ? destination : account)) && (!target || (a.id !== account && a.currency === selected?.currency))).map(a => <option key={a.id} value={a.id} disabled={a.archived}>{a.name} · {formatMoney(a.balance_minor, a.currency)} · {a.currency}{a.archived ? ' · архив' : ''}</option>)
  return <Editor title={item ? 'Редактировать операцию' : 'Новая операция'} onClose={onClose} submit={() => onSave('operations' + (item ? '/' + item.id : ''), item ? 'PUT' : 'POST', {
    kind, amount_minor: parseMinor(amount), occurred_on: date, account_id: account, destination_account_id: kind === 'transfer' ? destination || null : null,
    category_id: kind === 'transfer' ? null : category || null, comment: comment || null, expected_version: item?.version,
    adjustment_type: kind === 'transfer' ? null : adjustment, related_transaction_id: kind !== 'transfer' && adjustment ? related || null : null,
  })}>
    <div className="type-toggle">{(['expense', 'income', 'transfer'] as const).map(k => <button type="button" key={k} className={kind === k ? 'selected' : ''} onClick={() => { setKind(k); setCategory(data.categories.find(c => c.kind === k && !c.archived)?.id ?? '') }}>{({ expense: 'Расход', income: 'Доход', transfer: 'Перевод' })[k]}</button>)}</div>
    {kind !== 'transfer' && <label className="ledger-check"><input type="checkbox" checked={!!adjustment} onChange={e => setAdjustment(e.target.checked ? adjustment ?? 'return_funds' : null)} />Корректировка / возврат средств — не обычный доход</label>}
    {adjustment && kind !== 'transfer' && <><label className="field"><span>Исходная операция</span><select value={related} onChange={e => setRelated(e.target.value)}><option value="">Не подтверждена — требуется проверка</option>{data.operations.filter(o => o.id !== item?.id && !o.adjustment_type && o.kind !== 'transfer' && o.account_id === account && o.occurred_on <= date && o.kind !== kind).map(o => <option key={o.id} value={o.id}>{o.occurred_on} · {o.comment || 'Операция'} · {formatMoney(o.amount_minor, o.currency)}</option>)}</select></label><p className="ledger-hint">Связанный возврат уменьшает расходы исходной категории в дату возврата. Без связи корректировка меняет только остаток. Отмену своего перевода оформите обратным переводом между двумя счетами.</p></>}
    <label className="amount-field"><span>Сумма · {selected?.currency ?? 'выберите счёт'}</span><input required inputMode="decimal" placeholder="0" value={amount} onChange={e => setAmount(e.target.value)} /></label>
    <div className="form-grid"><label className="field"><span>{kind === 'transfer' ? 'Со счёта' : 'Счёт'}</span><select required value={account} onChange={e => { setAccount(e.target.value); setDestination('') }}><option value="">Выберите счёт</option>{options()}</select></label>
      {kind === 'transfer' ? <label className="field"><span>На счёт</span><select required value={destination} onChange={e => setDestination(e.target.value)}><option value="">Выберите счёт</option>{options(true)}</select></label> :
        <label className="field"><span>Категория</span><select required value={category} onChange={e => setCategory(e.target.value)}><option value="">Выберите категорию</option>{data.categories.filter(c => c.kind === kind && (!c.archived || c.id === category)).map(c => <option disabled={c.archived} value={c.id} key={c.id}>{c.name}{c.archived ? ' · архив' : ''}</option>)}</select></label>}</div>
    {kind === 'income' && selected?.kind === 'deposit' && <p className="ledger-hint">Для начисленных банком процентов выберите категорию «Проценты по депозиту». Если её нет, добавьте категорию дохода с этим названием в разделе «Категории».</p>}
    {kind === 'transfer' && <p className="ledger-hint">Перевод между своими счетами в одной валюте. Пополнение и снятие с депозита не считаются доходом или расходом.</p>}
    <label className="field"><span>Дата</span><input required type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
    <label className="field"><span>Комментарий · необязательно</span><textarea maxLength={1000} rows={2} value={comment} onChange={e => setComment(e.target.value)} /></label>
  </Editor>
}
export function Confirm({ title, description, action, onClose }: { title: string; description: string; action: () => Promise<void>; onClose: () => void }) {
  return <Editor title={title} onClose={onClose} submit={action}><p>{description}</p></Editor>
}
