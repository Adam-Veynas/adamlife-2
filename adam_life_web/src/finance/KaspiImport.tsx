import { useEffect, useMemo, useState } from 'react'
import { commitReadyPortion, filterImportRows, uploadPDF, type ImportFilter } from './importReview'
import { Modal } from '../components/Dialogs'
import { FinanceError, financeRequest, formatMoney, type Category, type Operation, type Snapshot } from './client'
import './imports.css'

interface Statement { start: string; end: string; opening_minor: string; closing_minor: string; last_four: string; product: string }
interface Upload { id: string; account_id: string | null; statement: Statement; found: number }
interface ImportRow { index: number; date: string; signed_minor: string; description: string; extra: string; bank_type: string; kind: string; category_id: string | null; category_name: string; other_account_id: string | null; status: string; requires_review: boolean; own_hint: boolean; candidates: Operation[]; related_candidates?: Operation[]; related_id: string | null; review_reasons?: string[] }
interface Choice { index: number; action?: string; kind?: string; category_id?: string; other_account_id?: string; match_id?: string; related_id?: string; reviewed?: boolean; remember_category?: boolean; remember_account?: boolean }
interface Review { rows: ImportRow[]; revision: string; found: number; duplicates: number; review: number; new: number; own_transfers: number; projected_minor: string; difference_minor: string; opening_date: string; opening_minor: string; before_opening?: number; needs_category?: number; financial_review?: number; preliminary?: boolean }
interface Result { found: number; added: number; duplicates: number; skipped: number; matched: number; remaining?: number; complete?: boolean; preliminary?: boolean }
interface History { id: string; status: string; created_at: string; account_id: string; statement: Statement; result: Result }
interface Rule { id: string; original: string; rule_type: string; category_id: string | null; account_id: string | null; version: number }

export function KaspiImport({ data, csrf, onChanged, onClose, onUnauthorized }: { data: Snapshot; csrf: string; onChanged: () => Promise<void>; onClose: () => void; onUnauthorized: () => void }) {
  const [tab, setTab] = useState<'upload' | 'history' | 'rules'>('upload'), [upload, setUpload] = useState<Upload | null>(null)
  const [account, setAccount] = useState(''), [review, setReview] = useState<Review | null>(null), [choices, setChoices] = useState<Record<number, Choice>>({})
  const [dirty, setDirty] = useState(false)
  const [addedCategories, setAddedCategories] = useState<Category[]>([])
  const categories = [...data.categories, ...addedCategories.filter(c => !data.categories.some(existing => existing.id === c.id))]
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<Result | null>(null)
  const [history, setHistory] = useState<History[]>([]), [rules, setRules] = useState<Rule[]>([])
  const [undoId, setUndoId] = useState<string | null>(null)
  const [filter, setFilter] = useState<ImportFilter>('all'), [page, setPage] = useState(0), [expanded, setExpanded] = useState<number | null>(null)
  const filtered = useMemo(() => filterImportRows(review?.rows ?? [], filter), [review, filter])
  const pageRows = filtered.slice(page * 25, (page + 1) * 25)
  const accounts = data.accounts.filter(a => !a.archived && a.currency === 'KZT')
  async function action(task: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await task() } catch (e) { if (e instanceof FinanceError && e.status === 401) onUnauthorized(); else setError(e instanceof Error ? e.message : 'Не удалось выполнить действие') }
    finally { setBusy(false) }
  }
  const request = <T,>(path: string, method = 'GET', body?: unknown) => financeRequest<T>('imports' + path, csrf, method, body)
  const body = () => ({ account_id: account, choices: Object.values(choices), ready_only: true, revision: review?.revision })
  async function calculate(id = upload?.id, selected = account) {
    if (!id || !selected) return
    const next = await request<Review>(`/${id}/review`, 'POST', { ...body(), account_id: selected })
    setReview(next); setDirty(false); setPage(0)
    return next
  }
  async function loadFile(file?: File) {
    if (!file) return
    const next = await uploadPDF<Upload>(file, csrf)
    setUpload(next); setChoices({}); setAccount(next.account_id ?? ''); setReview(null); setResult(null); setFilter('all'); setPage(0); setExpanded(null)
    if (next.account_id) {
      setReview(await request<Review>(`/${next.id}/review`, 'POST', { account_id: next.account_id, choices: [], ready_only: true })); setDirty(false)
    }
  }
  function change(index: number, patch: Partial<Choice>) { setChoices(previous => ({ ...previous, [index]: { ...previous[index], index, ...patch } })); setDirty(true) }
  async function saveCategory(row: ImportRow, categoryId: string, name: string, remember: boolean) {
    if (!upload) return
    if (name.trim()) {
      const kind = BigInt(row.signed_minor) > 0n ? 'income' : 'expense'
      const existing = categories.find(c => !c.archived && c.kind === kind && c.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase())
      const category = existing ?? await financeRequest<Category>('categories', csrf, 'POST', { name: name.trim(), kind })
      categoryId = category.id
      if (!existing) setAddedCategories(previous => [...previous, category])
    }
    if (!categoryId) throw new Error('Выберите категорию.')
    const saved = await request<{ review: Review; choices: Choice[] }>(`/${upload.id}/category`, 'POST', {
      ...body(), index: row.index, category_id: categoryId, remember,
    })
    setChoices(Object.fromEntries(saved.choices.map(choice => [choice.index, choice])))
    setReview(saved.review); setDirty(false)
  }
  async function close() { try { if (upload) await request(`/${upload.id}/preview`, 'DELETE') } finally { onClose() } }
  useEffect(() => { if (tab !== 'upload') void action(async () => { if (tab === 'history') setHistory(await request<History[]>('')); else setRules(await request<Rule[]>('/rules')) }) }, [tab]) // switching tabs never commits a preview
  return <Modal title="Импорт Kaspi Gold" onClose={() => { if (!busy) void action(close) }}><div className="kaspi-import">
    <div className="chart-switch import-tabs" role="group" aria-label="Импорт выписок">{(['upload', 'history', 'rules'] as const).map(value => <button key={value} disabled={busy} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{value === 'upload' ? 'Загрузить' : value === 'history' ? 'История' : 'Правила'}</button>)}</div>
    {error && <p className="form-error" role="alert">{error}</p>}{busy && <p role="status">Обрабатываем…</p>}
    {tab === 'upload' && <>
      {!upload && <><label className="field"><span>Текстовый PDF Kaspi Gold · до 5 МБ</span><input type="file" accept="application/pdf,.pdf" disabled={busy} onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void action(() => loadFile(file)) }} /></label><p className="ledger-hint">Сначала покажем операции и сверку. Деньги и счета изменятся только после подтверждения.</p></>}
      {upload && <><p className="ledger-hint">{upload.statement.product} · *{upload.statement.last_four}<br />{upload.statement.start} — {upload.statement.end} · {upload.found} операций</p>
        {!result?.complete && <><label className="field"><span>Банковский счёт</span><select value={account} disabled={busy || !!upload.account_id} onChange={e => { setAccount(e.target.value); setReview(null); setChoices({}); setDirty(true) }}><option value="">Выберите свой счёт KZT</option>{accounts.filter(a => a.kind === 'bank').map(a => <option key={a.id} value={a.id}>{a.name} · {a.bank_code}</option>)}</select></label>
          {!accounts.some(a => a.kind === 'bank') && <p>Сначала добавьте свой банковский счёт в разделе «Счета».</p>}
          <button className="button secondary" disabled={busy || !account} onClick={() => void action(() => calculate())}>{review ? 'Обновить расчёт' : 'Показать операции'}</button>
          {review && <fieldset className="import-review-controls" disabled={busy}>
            <div className="import-summary"><span>Готовы <b>{review.new}</b></span><span>Нужна категория <b>{review.needs_category ?? 0}</b></span><span>Финансовые вопросы <b>{review.financial_review ?? review.review}</b></span><span>Уже учтены <b>{review.duplicates}</b></span></div>
            <details className="import-reconcile"><summary>Сверка остатков · предварительно</summary><p>По выписке: {formatMoney(upload.statement.opening_minor, 'KZT')} → {formatMoney(upload.statement.closing_minor, 'KZT')}</p><p>Расчётный остаток после готовых операций на {upload.statement.end}: <strong>{formatMoney(review.projected_minor, 'KZT')}</strong></p><p>Расхождение: {formatMoney(review.difference_minor, 'KZT')}</p>
              <p className="ledger-hint">Это предварительный учётный остаток, а не подтверждённый остаток банка. Пока история неполна, суммы могут отличаться. Начальный остаток {formatMoney(review.opening_minor, 'KZT')} на {review.opening_date} не изменяется.</p>
            </details>
            {!!review.before_opening && <p className="ledger-hint">{review.before_opening} операций раньше начала учёта ({review.opening_date}). Они могут уже входить в начальный остаток и остаются на проверке. Остальные готовые операции можно сохранить.</p>}
            {dirty && <p role="status" className="ledger-hint">Решения изменены. Перед сохранением расчёт будет проверен повторно.</p>}
            <label className="field"><span>Показать операции</span><select value={filter} onChange={e => { setFilter(e.target.value as ImportFilter); setPage(0); setExpanded(null) }}><option value="all">Все</option><option value="defined">Определены</option><option value="review">Требуют проверки</option><option value="duplicates">Дубликаты</option></select></label>
            <p className="ledger-hint">Показано {pageRows.length} из {filtered.length} · страница {page + 1}</p>
            <div className="import-rows">{pageRows.map(row => {
              const choice = choices[row.index] ?? {}, kind = choice.kind ?? row.kind, signKind = BigInt(row.signed_minor) > 0n ? 'income' : 'expense'
              const actionValue = choice.action ?? 'add'
              if (row.status === 'review' && row.review_reasons?.length === 1 && row.review_reasons[0] === 'category') return <ImportCategoryRow key={row.index} row={row} categories={categories} disabled={busy} onSave={(category, name, remember) => action(() => saveCategory(row, category, name, remember))} />
              return <div key={row.index} className="import-item"><details open={expanded === row.index} className={`import-row ${row.status === 'review' || row.status === 'before_opening' ? 'needs-review' : ''}`}><summary onClick={e => { e.preventDefault(); setExpanded(expanded === row.index ? null : row.index) }}><span>{row.date} · {row.bank_type}<strong>{row.description}</strong><small>{categories.find(c => c.id === (choice.category_id ?? row.category_id))?.name ?? row.category_name} · {row.status === 'duplicate' ? 'Уже учтено' : row.status === 'before_opening' ? 'Раньше начала учёта' : row.status === 'review' ? 'Требует проверки' : row.status === 'skip' ? 'Пропущено' : 'Новая операция'}</small></span><b className={BigInt(row.signed_minor) < 0n ? 'negative' : 'positive'}>{formatMoney(row.signed_minor, 'KZT')}</b></summary>
                {expanded === row.index && row.review_reasons?.filter(reason => reason !== 'category').map(reason => <p className="ledger-hint" key={reason}>{reviewReason(reason)}</p>)}
                {expanded === row.index && row.extra && <p className="ledger-hint">{row.extra}</p>}
                {expanded === row.index && row.status !== 'duplicate' && <div className="import-row-fields"><label className="field"><span>Действие</span><select value={actionValue} onChange={e => change(row.index, { action: e.target.value })}><option value="add">Добавить</option><option value="skip">Пропустить</option>{row.candidates.length > 0 && <option value="match">Уже есть в истории</option>}</select></label>
                  {actionValue === 'match' && <label className="field"><span>Совпадающая операция</span><select value={choice.match_id ?? ''} onChange={e => change(row.index, { match_id: e.target.value, reviewed: true })}><option value="">Выберите запись</option>{row.candidates.map(o => <option key={o.id} value={o.id}>{o.occurred_on} · {o.comment || o.kind} · {formatMoney(o.amount_minor, o.currency)}</option>)}</select></label>}
                  {actionValue !== 'skip' && <><label className="field"><span>Тип</span><select value={kind} onChange={e => change(row.index, { kind: e.target.value, remember_category: false, remember_account: false })}><option value={signKind}>{signKind === 'income' ? 'Доход / поступление' : 'Расход'}</option><option value="transfer">Перевод между своими счетами</option><option value="adjustment">Корректировка / возврат, не заработок</option></select></label>
                    {kind === 'transfer' ? <><label className="field"><span>{signKind === 'income' ? 'С какого своего счёта' : 'На какой свой счёт'}</span><select value={choice.other_account_id ?? row.other_account_id ?? ''} onChange={e => change(row.index, { other_account_id: e.target.value })}><option value="">Выберите счёт</option>{accounts.filter(a => a.id !== account).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label className="ledger-check"><input type="checkbox" checked={choice.remember_account ?? false} onChange={e => change(row.index, { remember_account: e.target.checked })} />Это мой счёт. Запомнить привязку получателя.</label></> : kind === 'adjustment' ? <label className="field"><span>Исходный расход · без связи требуется проверка</span><select value={choice.related_id ?? row.related_id ?? ''} onChange={e => change(row.index, { related_id: e.target.value || undefined })}><option value="">Без связи — требует проверки</option>{data.operations.filter(o => !o.adjustment_type && o.kind !== 'transfer' && o.occurred_on <= row.date && (signKind === 'income' ? o.account_id === account && o.kind !== 'income' : (o.kind === 'income' && o.account_id === account) || o.destination_account_id === account)).map(o => <option key={o.id} value={o.id}>{o.occurred_on} · {o.comment || o.kind} · {formatMoney(o.amount_minor, o.currency)}</option>)}</select></label> : <ImportCategoryRow row={row} categories={categories} disabled={busy} onSave={(category, name, remember) => action(() => saveCategory(row, category, name, remember))} />}
                  </>}
                  {actionValue !== 'skip' && (row.requires_review || row.status === 'review') && <label className="ledger-check"><input type="checkbox" checked={choice.reviewed ?? false} onChange={e => change(row.index, { reviewed: e.target.checked })} />Проверил тип, счёт и совпадения. Подтверждаю решение.</label>}
                </div>}
              </details></div>
            })}</div>
            <div className="import-pagination"><button className="button secondary" disabled={page === 0} onClick={() => { setPage(page - 1); setExpanded(null) }}>Назад</button><button className="button secondary" disabled={(page + 1) * 25 >= filtered.length} onClick={() => { setPage(page + 1); setExpanded(null) }}>Далее</button></div>
          </fieldset>}
        </>}
      </>}
      {result && <div role="status"><h3>{result.complete ? 'Готовые операции сохранены' : 'Часть операций сохранена'}</h3><p>{result.remaining ? `Осталось на проверке: ${result.remaining}. Уточните их ниже или загрузите выписку повторно позже — сохранённые строки не продублируются.` : 'Остаток предварительный до завершения сверки.'}</p><p>Найдено: {result.found} · Добавлено: {result.added} · Дубликатов: {result.duplicates} · Сопоставлено: {result.matched} · Пропущено: {result.skipped}</p></div>}
    </>}
    {tab === 'history' && <div className="import-rows">{history.map(item => <article key={item.id}><strong>Kaspi Gold · {item.statement.start} — {item.statement.end}</strong><p className="ledger-hint">{new Date(item.created_at).toLocaleString('ru-RU')} · {data.accounts.find(a => a.id === item.account_id)?.name}</p><p>Добавлено {item.result.added}, дубликатов {item.result.duplicates}, пропущено {item.result.skipped}</p>{item.status === 'undone' ? <span>Отменён</span> : undoId === item.id ? <><p>Отменить только новые операции этого импорта? Изменённые и связанные записи защищены.</p><button className="button secondary" disabled={busy} onClick={() => void action(async () => { await request(`/${item.id}/undo`, 'POST', {}); setUndoId(null); setHistory(await request<History[]>('')); await onChanged() })}>Подтвердить отмену</button><button className="text-action" onClick={() => setUndoId(null)}>Назад</button></> : <button className="text-action" onClick={() => setUndoId(item.id)}>Отменить импорт</button>}</article>)}{!history.length && <p>Сохранённых импортов пока нет.</p>}</div>}
    {tab === 'rules' && <div className="import-rows">{rules.map(rule => <article key={rule.id}><strong>{rule.original}</strong><label className="field"><span>{rule.rule_type === 'category' ? 'Категория' : 'Собственный счёт'}</span><select value={(rule.rule_type === 'category' ? rule.category_id : rule.account_id) ?? ''} disabled={busy} onChange={e => void action(async () => { await request(`/rules/${rule.id}`, 'PUT', { expected_version: rule.version, [rule.rule_type === 'category' ? 'category_id' : 'account_id']: e.target.value }); setRules(await request<Rule[]>('/rules')) })}>{rule.rule_type === 'category' ? categories.map(c => <option key={c.id} value={c.id} disabled={c.archived}>{c.name} · {c.kind === 'income' ? 'доход' : 'расход'}</option>) : accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><button className="text-action danger-text" disabled={busy} onClick={() => void action(async () => { await request(`/rules/${rule.id}`, 'DELETE', { expected_version: rule.version }); setRules(await request<Rule[]>('/rules')) })}>Удалить правило</button></article>)}{!rules.length && <p>Правила появятся после подтверждения при импорте.</p>}</div>}
    <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => void action(close)}>Закрыть</button>{tab === 'upload' && upload && review && !result?.complete && <button className="button primary" disabled={busy || (!dirty && review.new === 0)} onClick={() => void action(async () => {
      const saved = await commitReadyPortion<Review, Result>(request, upload.id, body())
      setResult(saved)
      // The draft remains available; committed rows become duplicates on the next review.
      try { await onChanged() } catch { setError('Импорт сохранён. Обновите сводку, когда соединение восстановится.') }
      await calculate()
    })}>Импортировать готовые ({review.new})</button>}</div>
  </div></Modal>
}


function reviewReason(reason: string) {
  return ({ ownership: 'Нужно уточнить: это перевод на ваш счёт или другому человеку?', adjustment: 'Возврат или корректировка: уточните тип и исходную операцию. Это не обычный доход.', match: 'В истории есть движение с той же датой и суммой. Сопоставьте его или подтвердите отдельную покупку.', overlap: 'Похожая строка уже встречалась в другом импорте. Уточните, является ли это отдельным движением.', before_opening: 'Движение раньше начала учёта: сохранение могло бы учесть деньги дважды.', transfer_account: 'Нужен другой активный собственный счёт KZT с подходящей датой начала учёта.' } as Record<string, string>)[reason] ?? 'Уточните финансовый смысл операции.'
}

export function ImportCategoryRow({ row, categories, disabled, onSave }: { row: Pick<ImportRow, 'description' | 'signed_minor' | 'bank_type'>; categories: Category[]; disabled: boolean; onSave: (category: string, name: string, remember: boolean) => Promise<unknown> }) {
  const [category, setCategory] = useState(''), [name, setName] = useState('')
  const [remember, setRemember] = useState(row.bank_type !== 'Перевод')
  const kind = BigInt(row.signed_minor) > 0n ? 'income' : 'expense'
  return <article className="import-category-row">
    <strong>{row.description}</strong>
    <div className="import-category-actions"><select aria-label={`Категория: ${row.description}`} value={category} disabled={disabled} onChange={event => setCategory(event.target.value)}><option value="">Выберите категорию</option>{categories.filter(c => !c.archived && c.kind === kind).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}<option value="__new">+ Новая категория</option></select><button className="button secondary" disabled={disabled || !category || (category === '__new' && !name.trim())} onClick={() => void onSave(category === '__new' ? '' : category, category === '__new' ? name : '', remember)}>Сохранить</button></div>
    {category === '__new' && <input aria-label="Название новой категории" placeholder="Название категории" maxLength={80} value={name} disabled={disabled} onChange={event => setName(event.target.value)} />}
    {row.bank_type === 'Перевод' ? <label className="ledger-check"><input type="checkbox" checked={remember} disabled={disabled} onChange={event => setRemember(event.target.checked)} />Запомнить для будущих переводов этому получателю</label> : <small className="ledger-hint">Применим к этому получателю и запомним. Правило можно изменить в «Правилах».</small>}
  </article>
}
