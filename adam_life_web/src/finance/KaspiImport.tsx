import { useEffect, useMemo, useState } from 'react'
import { bulkReview, canBulkReview, filterImportRows, uploadPDF, type ImportFilter } from './importReview'
import { Modal } from '../components/Dialogs'
import { FinanceError, financeRequest, formatMoney, type Operation, type Snapshot } from './client'
import './imports.css'

interface Statement { start: string; end: string; opening_minor: string; closing_minor: string; last_four: string; product: string }
interface Upload { id: string; account_id: string | null; statement: Statement; found: number }
interface ImportRow { index: number; date: string; signed_minor: string; description: string; extra: string; bank_type: string; kind: string; category_id: string | null; category_name: string; other_account_id: string | null; status: string; requires_review: boolean; own_hint: boolean; candidates: Operation[]; related_candidates?: Operation[]; related_id: string | null }
interface Choice { index: number; action?: string; kind?: string; category_id?: string; other_account_id?: string; match_id?: string; related_id?: string; reviewed?: boolean; remember_category?: boolean; remember_account?: boolean }
interface Review { rows: ImportRow[]; revision: string; found: number; duplicates: number; review: number; new: number; own_transfers: number; projected_minor: string; difference_minor: string; opening_date: string; opening_minor: string; before_opening?: number }
interface Result { found: number; added: number; duplicates: number; skipped: number; matched: number }
interface History { id: string; status: string; created_at: string; account_id: string; statement: Statement; result: Result }
interface Rule { id: string; original: string; rule_type: string; category_id: string | null; account_id: string | null; version: number }

export function KaspiImport({ data, csrf, onChanged, onClose, onUnauthorized }: { data: Snapshot; csrf: string; onChanged: () => Promise<void>; onClose: () => void; onUnauthorized: () => void }) {
  const [tab, setTab] = useState<'upload' | 'history' | 'rules'>('upload'), [upload, setUpload] = useState<Upload | null>(null)
  const [account, setAccount] = useState(''), [review, setReview] = useState<Review | null>(null), [choices, setChoices] = useState<Record<number, Choice>>({})
  const [opening, setOpening] = useState(false), [difference, setDifference] = useState(false), [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<Result | null>(null)
  const [history, setHistory] = useState<History[]>([]), [rules, setRules] = useState<Rule[]>([])
  const [undoId, setUndoId] = useState<string | null>(null)
  const [filter, setFilter] = useState<ImportFilter>('all'), [page, setPage] = useState(0), [expanded, setExpanded] = useState<number | null>(null)
  const [selected, setSelected] = useState<number[]>([]), [bulkCategory, setBulkCategory] = useState(''), [rememberBulk, setRememberBulk] = useState(false)
  const filtered = useMemo(() => filterImportRows(review?.rows ?? [], filter), [review, filter])
  const pageRows = filtered.slice(page * 25, (page + 1) * 25)
  const accounts = data.accounts.filter(a => !a.archived && a.currency === 'KZT')
  async function action(task: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await task() } catch (e) { if (e instanceof FinanceError && e.status === 401) onUnauthorized(); else setError(e instanceof Error ? e.message : 'Не удалось выполнить действие') }
    finally { setBusy(false) }
  }
  const request = <T,>(path: string, method = 'GET', body?: unknown) => financeRequest<T>('imports' + path, csrf, method, body)
  const body = () => ({ account_id: account, choices: Object.values(choices), use_statement_opening: opening, revision: review?.revision, acknowledge_difference: difference })
  async function calculate(id = upload?.id, selected = account) {
    if (!id || !selected) return
    const next = await request<Review>(`/${id}/review`, 'POST', { ...body(), account_id: selected })
    setReview(next); setDirty(false); setPage(0); setSelected([])
    return next
  }
  async function loadFile(file?: File) {
    if (!file) return
    const next = await uploadPDF<Upload>(file, csrf)
    setUpload(next); setChoices({}); setOpening(false); setDifference(false); setAccount(next.account_id ?? ''); setReview(null); setResult(null); setFilter('all'); setPage(0); setSelected([]); setExpanded(null)
    if (next.account_id) {
      setReview(await request<Review>(`/${next.id}/review`, 'POST', { account_id: next.account_id, choices: [], use_statement_opening: false })); setDirty(false)
    }
  }
  function change(index: number, patch: Partial<Choice>) { setChoices(previous => ({ ...previous, [index]: { ...previous[index], index, ...patch } })); setDirty(true) }
  function applyBulk() {
    try {
      const category = data.categories.find(c => c.id === bulkCategory)
      setChoices(bulkReview(review?.rows ?? [], selected, choices, category, rememberBulk)); setDirty(true); setSelected([]); setError('')
    } catch (e) { setError(e instanceof Error ? e.message : 'Проверьте выбранные операции') }
  }
  async function close() { try { if (upload && !result) await request(`/${upload.id}/preview`, 'DELETE') } finally { onClose() } }
  useEffect(() => { if (tab !== 'upload') void action(async () => { if (tab === 'history') setHistory(await request<History[]>('')); else setRules(await request<Rule[]>('/rules')) }) }, [tab]) // switching tabs never commits a preview
  return <Modal title="Импорт Kaspi Gold" onClose={() => { if (!busy) void action(close) }}><div className="kaspi-import">
    <div className="chart-switch import-tabs" role="group" aria-label="Импорт выписок">{(['upload', 'history', 'rules'] as const).map(value => <button key={value} disabled={busy} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{value === 'upload' ? 'Загрузить' : value === 'history' ? 'История' : 'Правила'}</button>)}</div>
    {error && <p className="form-error" role="alert">{error}</p>}{busy && <p role="status">Обрабатываем…</p>}
    {tab === 'upload' && <>
      {!upload && <><label className="field"><span>Текстовый PDF Kaspi Gold · до 5 МБ</span><input type="file" accept="application/pdf,.pdf" disabled={busy} onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void action(() => loadFile(file)) }} /></label><p className="ledger-hint">Сначала покажем операции и сверку. Деньги и счета изменятся только после подтверждения.</p></>}
      {upload && <><p className="ledger-hint">{upload.statement.product} · *{upload.statement.last_four}<br />{upload.statement.start} — {upload.statement.end} · {upload.found} операций</p>
        {!result && <><label className="field"><span>Банковский счёт</span><select value={account} disabled={busy || !!upload.account_id} onChange={e => { setAccount(e.target.value); setReview(null); setChoices({}); setOpening(false); setDirty(true) }}><option value="">Выберите свой счёт KZT</option>{accounts.filter(a => a.kind === 'bank').map(a => <option key={a.id} value={a.id}>{a.name} · {a.bank_code}</option>)}</select></label>
          {!accounts.some(a => a.kind === 'bank') && <p>Сначала добавьте свой банковский счёт в разделе «Счета».</p>}
          <button className="button secondary" disabled={busy || !account} onClick={() => void action(() => calculate())}>{review ? 'Обновить расчёт' : 'Показать операции'}</button>
          {review && <fieldset className="import-review-controls" disabled={busy}>
            <div className="import-summary"><span>Новые <b>{review.new}</b></span><span>Дубликаты <b>{review.duplicates}</b></span><span>Проверить <b>{review.review}</b></span><span>Возможные свои переводы <b>{review.own_transfers}</b></span></div>
            <details className="import-reconcile" open={!!review.before_opening}><summary>Сверка остатков</summary><p>По выписке: {formatMoney(upload.statement.opening_minor, 'KZT')} → {formatMoney(upload.statement.closing_minor, 'KZT')}</p><p>После импорта на {upload.statement.end}: <strong>{formatMoney(review.projected_minor, 'KZT')}</strong></p><p>Расхождение: {formatMoney(review.difference_minor, 'KZT')}</p>
              <p className="ledger-hint">Начало учёта: {review.opening_date}, остаток {formatMoney(review.opening_minor, 'KZT')}. Не импортируйте повторно операции, уже включённые в начальный остаток.</p>
              <label className="ledger-check"><input type="checkbox" checked={opening} onChange={e => { setOpening(e.target.checked); setDirty(true) }} />Использовать дату и начальный остаток выписки. Подтверждаю изменение начала учёта.</label>
              {review.difference_minor !== '0' && <label className="ledger-check"><input type="checkbox" checked={difference} onChange={e => setDifference(e.target.checked)} />Сохранить с указанным расхождением. Баланс автоматически не выравнивать.</label>}
            </details>
            {!!review.before_opening && <p className="form-error" role="status">{review.before_opening} операций раньше начала учёта. Согласуйте дату и остаток в блоке «Сверка остатков» выше или пропустите эти строки.</p>}
            {review.review > 0 && !dirty && <p className="ledger-hint">Проверить: {review.review}. Выберите фильтр «Требуют проверки». Обычным операциям можно назначить категорию и подтвердить их вместе; переводы и возвраты проверяются отдельно.</p>}
            {review.difference_minor !== '0' && !difference && <p className="ledger-hint">Для сохранения нужно устранить или явно подтвердить расхождение в «Сверке остатков».</p>}
            {dirty && <p role="status" className="ledger-hint">Решения изменены. Перед сохранением расчёт будет проверен повторно.</p>}
            <label className="field"><span>Показать операции</span><select value={filter} onChange={e => { setFilter(e.target.value as ImportFilter); setPage(0); setExpanded(null) }}><option value="all">Все</option><option value="defined">Определены</option><option value="review">Требуют проверки</option><option value="duplicates">Дубликаты</option></select></label>
            <div className="import-bulk">
              <button className="text-action" disabled={busy} onClick={() => setSelected(filtered.filter(row => canBulkReview(row, choices[row.index])).map(row => row.index))}>Выбрать обычные операции в фильтре</button>
              {selected.length > 0 && <><p>Выбрано: {selected.length}. Возвраты, свои переводы и совпадения не включены.</p>
                <label className="field"><span>Категория выбранных</span><select value={bulkCategory} onChange={e => setBulkCategory(e.target.value)}><option value="">Оставить предложенные категории</option>{data.categories.filter(c => !c.archived).map(c => <option key={c.id} value={c.id}>{c.name} · {c.kind === 'income' ? 'доход' : 'расход'}</option>)}</select></label>
                {bulkCategory && <label className="ledger-check"><input type="checkbox" checked={rememberBulk} onChange={e => setRememberBulk(e.target.checked)} />Запомнить категорию для выбранных продавцов</label>}
                <button className="button secondary" disabled={busy} onClick={applyBulk}>Подтвердить выбранные</button><button className="text-action" onClick={() => setSelected([])}>Снять выбор</button>
              </>}
            </div>
            <p className="ledger-hint">Показано {pageRows.length} из {filtered.length} · страница {page + 1}</p>
            <div className="import-rows">{pageRows.map(row => {
              const choice = choices[row.index] ?? {}, kind = choice.kind ?? row.kind, signKind = BigInt(row.signed_minor) > 0n ? 'income' : 'expense'
              const actionValue = choice.action ?? 'add'
              return <div key={row.index} className="import-item">{canBulkReview(row, choice.index === undefined ? undefined : choice as Choice) && <input className="import-select" type="checkbox" aria-label={`Выбрать операцию ${row.index + 1}`} checked={selected.includes(row.index)} disabled={busy} onChange={e => setSelected(previous => e.target.checked ? [...previous, row.index] : previous.filter(index => index !== row.index))} />}<details open={expanded === row.index} className={`import-row ${row.status === 'review' || row.status === 'before_opening' ? 'needs-review' : ''}`}><summary onClick={e => { e.preventDefault(); setExpanded(expanded === row.index ? null : row.index) }}><span>{row.date} · {row.bank_type}<strong>{row.description}</strong><small>{data.categories.find(c => c.id === (choice.category_id ?? row.category_id))?.name ?? row.category_name} · {row.status === 'duplicate' ? 'Уже учтено' : row.status === 'before_opening' ? 'Раньше начала учёта' : row.status === 'review' ? 'Требует проверки' : row.status === 'skip' ? 'Пропущено' : 'Новая операция'}</small></span><b className={BigInt(row.signed_minor) < 0n ? 'negative' : 'positive'}>{formatMoney(row.signed_minor, 'KZT')}</b></summary>
                {expanded === row.index && row.extra && <p className="ledger-hint">{row.extra}</p>}
                {expanded === row.index && row.status !== 'duplicate' && <div className="import-row-fields"><label className="field"><span>Действие</span><select value={actionValue} onChange={e => change(row.index, { action: e.target.value })}><option value="add">Добавить</option><option value="skip">Пропустить</option>{row.candidates.length > 0 && <option value="match">Уже есть в истории</option>}</select></label>
                  {actionValue === 'match' && <label className="field"><span>Совпадающая операция</span><select value={choice.match_id ?? ''} onChange={e => change(row.index, { match_id: e.target.value, reviewed: true })}><option value="">Выберите запись</option>{row.candidates.map(o => <option key={o.id} value={o.id}>{o.occurred_on} · {o.comment || o.kind} · {formatMoney(o.amount_minor, o.currency)}</option>)}</select></label>}
                  {actionValue !== 'skip' && <><label className="field"><span>Тип</span><select value={kind} onChange={e => change(row.index, { kind: e.target.value, remember_category: false, remember_account: false })}><option value={signKind}>{signKind === 'income' ? 'Доход / поступление' : 'Расход'}</option><option value="transfer">Перевод между своими счетами</option><option value="adjustment">Корректировка / возврат, не заработок</option></select></label>
                    {kind === 'transfer' ? <><label className="field"><span>{signKind === 'income' ? 'С какого своего счёта' : 'На какой свой счёт'}</span><select value={choice.other_account_id ?? row.other_account_id ?? ''} onChange={e => change(row.index, { other_account_id: e.target.value })}><option value="">Выберите счёт</option>{accounts.filter(a => a.id !== account).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label className="ledger-check"><input type="checkbox" checked={choice.remember_account ?? false} onChange={e => change(row.index, { remember_account: e.target.checked })} />Это мой счёт. Запомнить привязку получателя.</label></> : kind === 'adjustment' ? <label className="field"><span>Исходный расход · без связи требуется проверка</span><select value={choice.related_id ?? row.related_id ?? ''} onChange={e => change(row.index, { related_id: e.target.value || undefined })}><option value="">Без связи — требует проверки</option>{data.operations.filter(o => !o.adjustment_type && o.kind !== 'transfer' && o.occurred_on <= row.date && (signKind === 'income' ? o.account_id === account && o.kind !== 'income' : (o.kind === 'income' && o.account_id === account) || o.destination_account_id === account)).map(o => <option key={o.id} value={o.id}>{o.occurred_on} · {o.comment || o.kind} · {formatMoney(o.amount_minor, o.currency)}</option>)}</select></label> : <><label className="field"><span>Категория</span><select value={choice.category_id ?? row.category_id ?? ''} onChange={e => change(row.index, { category_id: e.target.value || undefined })}><option value="">{row.category_name} · предложено</option>{data.categories.filter(c => c.kind === signKind && !c.archived).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="ledger-check"><input type="checkbox" checked={choice.remember_category ?? false} onChange={e => change(row.index, { remember_category: e.target.checked })} />Запомнить категорию для следующих операций</label></>}
                  </>}
                  {actionValue !== 'skip' && (row.requires_review || row.status === 'review') && <label className="ledger-check"><input type="checkbox" checked={choice.reviewed ?? false} onChange={e => change(row.index, { reviewed: e.target.checked })} />Проверил тип, счёт и совпадения. Подтверждаю решение.</label>}
                </div>}
              </details></div>
            })}</div>
            <div className="import-pagination"><button className="button secondary" disabled={page === 0} onClick={() => { setPage(page - 1); setExpanded(null) }}>Назад</button><button className="button secondary" disabled={(page + 1) * 25 >= filtered.length} onClick={() => { setPage(page + 1); setExpanded(null) }}>Далее</button></div>
          </fieldset>}
        </>}
      </>}
      {result && <div role="status"><h3>Импорт завершён</h3><p>Найдено: {result.found} · Добавлено: {result.added} · Дубликатов: {result.duplicates} · Сопоставлено: {result.matched} · Пропущено: {result.skipped}</p></div>}
    </>}
    {tab === 'history' && <div className="import-rows">{history.map(item => <article key={item.id}><strong>Kaspi Gold · {item.statement.start} — {item.statement.end}</strong><p className="ledger-hint">{new Date(item.created_at).toLocaleString('ru-RU')} · {data.accounts.find(a => a.id === item.account_id)?.name}</p><p>Добавлено {item.result.added}, дубликатов {item.result.duplicates}, пропущено {item.result.skipped}</p>{item.status === 'undone' ? <span>Отменён</span> : undoId === item.id ? <><p>Отменить только новые операции этого импорта? Изменённые и связанные записи защищены.</p><button className="button secondary" disabled={busy} onClick={() => void action(async () => { await request(`/${item.id}/undo`, 'POST', {}); setUndoId(null); setHistory(await request<History[]>('')); await onChanged() })}>Подтвердить отмену</button><button className="text-action" onClick={() => setUndoId(null)}>Назад</button></> : <button className="text-action" onClick={() => setUndoId(item.id)}>Отменить импорт</button>}</article>)}{!history.length && <p>Сохранённых импортов пока нет.</p>}</div>}
    {tab === 'rules' && <div className="import-rows">{rules.map(rule => <article key={rule.id}><strong>{rule.original}</strong><label className="field"><span>{rule.rule_type === 'category' ? 'Категория' : 'Собственный счёт'}</span><select value={(rule.rule_type === 'category' ? rule.category_id : rule.account_id) ?? ''} disabled={busy} onChange={e => void action(async () => { await request(`/rules/${rule.id}`, 'PUT', { expected_version: rule.version, [rule.rule_type === 'category' ? 'category_id' : 'account_id']: e.target.value }); setRules(await request<Rule[]>('/rules')) })}>{rule.rule_type === 'category' ? data.categories.map(c => <option key={c.id} value={c.id} disabled={c.archived}>{c.name} · {c.kind === 'income' ? 'доход' : 'расход'}</option>) : accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><button className="text-action danger-text" disabled={busy} onClick={() => void action(async () => { await request(`/rules/${rule.id}`, 'DELETE', { expected_version: rule.version }); setRules(await request<Rule[]>('/rules')) })}>Удалить правило</button></article>)}{!rules.length && <p>Правила появятся после подтверждения при импорте.</p>}</div>}
    <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => void action(close)}>{result ? 'Закрыть' : 'Отмена'}</button>{tab === 'upload' && upload && review && !result && <button className="button primary" disabled={busy || (!dirty && (review.review > 0 || (review.difference_minor !== '0' && !difference)))} onClick={() => void action(async () => { const latest = await calculate(); if (!latest) return; if (latest.review) throw new Error(`Осталось проверить ${latest.review} операций. Откройте фильтр «Требуют проверки» и согласуйте начало учёта.`); if (latest.difference_minor !== '0' && !difference) throw new Error('Проверьте расхождение в блоке «Сверка остатков».'); const saved = await request<Result>(`/${upload.id}/commit`, 'POST', { ...body(), revision: latest.revision }); setResult(saved); try { await onChanged() } catch { setError('Импорт сохранён. Обновите сводку, когда соединение восстановится.') } })}>{dirty ? 'Проверить и сохранить' : 'Подтвердить импорт'}</button>}</div>
  </div></Modal>
}
