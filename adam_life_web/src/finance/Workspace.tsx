import { useEffect, useRef, useState } from 'react'
import { LogOut, Pencil, Plus } from 'lucide-react'
import { Layout, navigation } from '../components/Layout'
import { Modal } from '../components/Dialogs'
import { localDate, type View } from '../domain/finance'
import type { Session } from '../auth/client'
import { AccountEditor, CategoryEditor, Confirm, OperationEditor } from './Editors'
import { FinanceError, filterOperations, financeRequest, formatMoney, movement, totals, type Account, type Category, type Currency, type Operation, type Snapshot } from './client'
import { DepositComparison } from './DepositHistoryViews'
import { DepositDetails, type DepositTab, type TransferPreset } from './DepositDetails'
import { AccountGroups } from './AccountGroups'
import { OperationRows } from './OperationRows'
import { KaspiImport } from './KaspiImport'
import { FinancialAnalytics } from './FinancialAnalytics'
import type { AnalyticsDrilldown } from './analytics'
import { useAppNavigation } from '../hooks/useAppNavigation'
import './finance.css'

type Dialog = ({ type: 'import' } | { type: 'accountDetail'; item: Account; tab?: DepositTab } | { type: 'account'; item?: Account; initialKind?: Account['kind'] } | { type: 'category'; item?: Category } | { type: 'operation'; item?: Operation; preset?: TransferPreset } | { type: 'detail'; item: Operation } | { type: 'confirm'; actionLabel: string; title: string; description: string; action: () => Promise<void> }) & { returnDeposit?: string } | null
export function FinancialWorkspace({ session, onLogout, onUnauthorized }: { session: Session; onLogout: () => void; onUnauthorized: () => void }) {
  const [data, setData] = useState<Snapshot | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const [dialog, setDialog] = useState<Dialog>(null)
  const appNavigation = useAppNavigation(() => setDialog(null))
  const { view, manage } = appNavigation.route
  const setManage = (next: 'accounts' | 'categories' | null) => appNavigation.go({ view, manage: next })
  const [currency, setCurrency] = useState<Currency>('KZT'), [account, setAccount] = useState(''), [kind, setKind] = useState(''), [category, setCategory] = useState('')
  const [historyAccounts, setHistoryAccounts] = useState<string[]>([])
  const [from, setFrom] = useState(localDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1))), [to, setTo] = useState(''), [archive, setArchive] = useState(false)
  const alive = useRef(true), csrf = session.csrf_token
  const unauthorized = useRef(onUnauthorized); unauthorized.current = onUnauthorized
  useEffect(() => {
    alive.current = true
    const abort = new AbortController()
    async function load() {
      try { await financeRequest('bootstrap', csrf, 'POST', {}, abort.signal); const next = await financeRequest<Snapshot>('snapshot', csrf, 'GET', undefined, abort.signal); if (!abort.signal.aborted) { setData(next); setLoading(false) } }
      catch (e) { if (abort.signal.aborted) return; if (e instanceof FinanceError && e.status === 401) unauthorized.current(); else { setError(e instanceof Error ? e.message : 'Не удалось загрузить данные'); setLoading(false) } }
    }
    void load()
    return () => { alive.current = false; abort.abort() }
  }, [csrf])
  async function refresh() {
    const next = await financeRequest<Snapshot>('snapshot', csrf)
    if (alive.current) { setData(next); setError('') }
  }
  async function save(path: string, method: string, body: unknown) {
    try {
      await financeRequest(path, csrf, method, body)
    } catch (e) {
      if (e instanceof FinanceError && e.status === 401) { setData(null); unauthorized.current() }
      throw e instanceof FinanceError ? e : new Error('Ответ не получен. Обновите данные и проверьте историю перед повтором, чтобы не создать дубликат.')
    }
    // A saved mutation must not look like a failed save if only the refresh fails.
    try { await refresh() } catch (e) {
      if (e instanceof FinanceError && e.status === 401) { setData(null); unauthorized.current() }
      else if (alive.current) setError('Запись сохранена, но сводка не обновилась. Нажмите «Обновить».')
    }
  }
  const close = () => {
    const deposit = data?.accounts.find(a => a.id === dialog?.returnDeposit)
    setDialog(deposit ? { type: 'accountDetail', item: deposit, tab: 'history' } : null)
  }
  const detailAccount = dialog?.type === 'accountDetail' ? data?.accounts.find(a => a.id === dialog.item.id) ?? dialog.item : null
  function navigate(next: View) { appNavigation.go({ view: next, manage: null }); setDialog(null); window.scrollTo({ top: 0, behavior: 'instant' }) }
  const rows = data ? filterOperations(data.operations, { currency, account, accounts: historyAccounts, kind, category: category === '__unassigned' ? '' : category, categoryUnassigned: category === '__unassigned', from, to }) : []
  const monthly = data ? totals(filterOperations(data.operations, { currency, account: '', kind: '', category: '', from: data.as_of.slice(0, 7) + '-01', to: data.as_of })) : totals([])
  const summary = totals(rows), balance = data?.balances[currency]
  const name = (id: string | null) => data?.accounts.find(a => a.id === id)?.name ?? 'Счёт'
  const categoryName = (id: string | null) => data?.categories.find(c => c.id === id)?.name ?? 'Перевод'
  const label = (row: Operation) => row.kind === 'transfer' ? `${name(row.account_id)} → ${name(row.destination_account_id)}` : name(row.account_id)
  const add = () => setDialog(data?.accounts.some(a => !a.archived) ? { type: 'operation' } : { type: 'account' })
  function showHistory(a: Account) { setCurrency(a.currency); setAccount(a.id); setHistoryAccounts([]); setFrom(''); setTo(''); setKind(''); setCategory(''); navigate('transactions') }
  function showCategory(filter: AnalyticsDrilldown) {
    setCurrency(filter.currency); setAccount(filter.accounts.length === 1 ? filter.accounts[0] : '')
    setHistoryAccounts(filter.accounts.length > 1 ? filter.accounts : [])
    setFrom(filter.from); setTo(filter.to); setKind(filter.kind); setCategory(filter.category ?? '__unassigned'); navigate('transactions')
  }
  function archiveItem(item: Account | Category, type: 'accounts' | 'categories') {
    setDialog({ type: 'confirm', actionLabel: item.archived ? 'Восстановить' : 'В архив', title: item.archived ? 'Восстановить из архива?' : 'Архивировать?', description: 'История и остатки сохраняются. Новые операции доступны только для активных счетов и категорий.',
      action: () => save(`${type}/${item.id}`, 'PUT', { ...(type === 'accounts' ? { name: item.name, kind: item.kind, bank_code: (item as Account).bank_code, currency: (item as Account).currency, opening_balance_minor: (item as Account).opening_balance_minor, opening_date: (item as Account).opening_date } : { name: item.name, kind: item.kind }), archived: !item.archived, expected_version: item.version }) })
  }
  function remove(item: Account | Category | Operation, type: 'accounts' | 'categories' | 'operations') {
    setDialog({ type: 'confirm', actionLabel: 'Удалить', returnDeposit: dialog?.returnDeposit, title: 'Удалить запись?', description: type === 'operations' ? 'Баланс затронутых счетов будет пересчитан. Действие останется в аудите.' : 'Удаление доступно только без истории операций. Начальный остаток удаляемого счёта также исключается из общего баланса.', action: () => save(`${type}/${item.id}`, 'DELETE', { expected_version: item.version }) })
  }
  function operationList(items: Operation[]) {
    return <section className="panel ledger-history"><div className="panel-heading"><h2>{view === 'overview' ? 'Последние операции' : 'История операций'}</h2>{view === 'overview' && <button className="text-action" onClick={() => navigate('transactions')}>Все операции</button>}</div>
      {data && <OperationRows items={items} data={data} accountId={view === 'transactions' ? account : ''} onSelect={item => setDialog({ type: 'detail', item })} />}
    </section>
  }
  return <Layout historyNavigation={appNavigation} view={view} onNavigate={navigate} onAdd={data ? add : undefined} accountControl={<button className="button secondary auth-logout" onClick={onLogout}><LogOut size={16} />Выйти</button>}>
    <div className="page-content ledger"><header className="page-header"><div><h1>{manage === 'accounts' ? 'Мои счета' : manage === 'categories' ? 'Категории' : navigation.find(n => n.id === view)?.title}</h1><p>{session.user.display_name}</p></div>{data && <button className="button primary desktop-add" onClick={add}><Plus size={17} />Добавить операцию</button>}</header>
      <div className="ledger-tools"><button className="button secondary" onClick={() => setDialog({ type: 'import' })} disabled={!data}>Импорт выписки</button><button className="button secondary" onClick={() => { setManage(manage === 'accounts' ? null : 'accounts'); setArchive(false) }}>Счета</button><button className="button secondary" onClick={() => { setManage(manage === 'categories' ? null : 'categories'); setArchive(false) }}>Категории</button><label className="field"><span className="sr-only">Валюта сводки</span><select aria-label="Валюта сводки" value={currency} onChange={e => { setCurrency(e.target.value as Currency); setAccount(''); setHistoryAccounts([]) }}>{['KZT', 'USD', 'EUR'].map(c => <option key={c}>{c}</option>)}</select></label><button className="text-action" onClick={() => void refresh().catch(e => { if (e instanceof FinanceError && e.status === 401) unauthorized.current(); else setError('Не удалось обновить данные') })}>Обновить</button></div>
      {loading && <p role="status">Загружаем ваши финансы…</p>}{error && <p role="alert" className="form-error">{error}</p>}
      {data && <>
        {(manage === 'accounts' || manage === 'categories') && <><div className="panel-heading"><h2>{manage === 'accounts' ? 'Счета пользователя' : 'Доходы и расходы'}</h2><button className="button primary" onClick={() => setDialog({ type: manage === 'accounts' ? 'account' : 'category' })}><Plus size={16} />Добавить</button></div><label className="ledger-check"><input type="checkbox" checked={archive} onChange={e => setArchive(e.target.checked)} />Показать архив</label>
          {manage === 'accounts' && <DepositComparison data={data} />}
          <div className="ledger-management">{(manage === 'accounts' ? data.accounts : data.categories).filter(i => archive || !i.archived).map(item => <article className="panel ledger-item" key={item.id}><div><h3>{item.name}{item.archived ? ' · архив' : ''}</h3><p>{'balance_minor' in item ? `${item.bank_code ?? ''} · ${item.kind === 'deposit' ? 'Депозит' : item.kind === 'cash' ? 'Наличные' : 'Банковский счёт'}` : item.kind === 'income' ? 'Доходы' : 'Расходы'}</p>{'balance_minor' in item && <strong>{formatMoney(item.balance_minor, item.currency)}</strong>}</div><div className="ledger-item-actions">{'balance_minor' in item && <><button className="text-action" onClick={() => setDialog({ type: 'accountDetail', item })}>Подробнее</button><button className="text-action" onClick={() => showHistory(item)}>История</button></>}<button className="text-action" onClick={() => setDialog('balance_minor' in item ? { type: 'account', item } : { type: 'category', item })}>Изменить</button><button className="text-action" onClick={() => archiveItem(item, manage)}>{item.archived ? 'Восстановить' : 'В архив'}</button><button className="text-action danger-text" onClick={() => remove(item, manage)}>Удалить</button></div></article>)}</div>
          {manage === 'accounts' && !data.accounts.length && <p className="small-empty">Добавьте свой первый счёт. Начните с остатка на выбранную дату.</p>}</>}
        {!manage && view === 'overview' && <>
          <section className="summary-panel home-summary"><div className="balance-metric"><div className="metric-label">Всего средств · {currency}</div><div className="balance-value">{formatMoney(balance?.total_minor ?? '0', currency)}</div><span className="balance-subtitle">Включая архивные счета · валюты учитываются отдельно</span></div><div className="summary-metric"><div className="metric-label">Доходы за месяц</div><strong className="metric-value positive">{formatMoney(monthly.income, currency)}</strong></div><div className="summary-metric"><div className="metric-label">Расходы за месяц</div><strong className="metric-value negative">{formatMoney(monthly.expense, currency)}</strong></div></section>
          <div className="ledger-split"><article className="panel"><span>Доступные средства</span><strong>{formatMoney(balance?.current_minor ?? '0', currency)}</strong></article><article className="panel"><span>Накопления</span><strong>{formatMoney(balance?.deposit_minor ?? '0', currency)}</strong></article></div>
          <AccountGroups accounts={data.accounts} currency={currency} onOpen={item => setDialog({ type: 'accountDetail', item })} onAdd={initialKind => setDialog({ type: 'account', initialKind })} />
          {operationList(data.operations.filter(o => o.currency === currency).slice(0, 5))}
        </>}
        {!manage && view === 'transactions' && <><div className="ledger-filters"><label className="field"><span>Счёт</span><select value={historyAccounts.length ? "__selection" : account} onChange={e => { setAccount(e.target.value); setHistoryAccounts([]) }}><option value="">Все счета</option>{historyAccounts.length > 0 && <option value="__selection">Выбрано счетов: {historyAccounts.length}</option>}{data.accounts.filter(a => a.currency === currency).map(a => <option value={a.id} key={a.id}>{a.name}{a.archived ? ' · архив' : ''}</option>)}</select></label><label className="field"><span>Тип</span><select value={kind} onChange={e => { setKind(e.target.value); setCategory('') }}><option value="">Все операции</option><option value="income">Доход</option><option value="expense">Расход</option><option value="transfer">Перевод</option><option value="adjustment">Корректировка / возврат</option></select></label><label className="field"><span>Категория</span><select value={category} onChange={e => setCategory(e.target.value)}><option value="">Все категории</option><option value="__unassigned">Без категории</option>{category && category !== "__unassigned" && !data.categories.some(c => c.id === category) && <option value={category}>Неизвестная категория</option>}{data.categories.filter(c => !kind || kind === 'adjustment' || kind === c.kind).map(c => <option key={c.id} value={c.id}>{c.name} · {c.kind === 'income' ? 'доход' : 'расход'}</option>)}</select></label><label className="field"><span>С даты</span><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label className="field"><span>По дату</span><input type="date" value={to} onChange={e => setTo(e.target.value)} /></label><button className="text-action" onClick={() => { setFrom(''); setTo('') }}>Всё время</button></div><section className="filter-summary"><div><span>Найдено операций</span><strong>{rows.length}</strong></div><div><span>Доходы</span><strong className="positive">{formatMoney(summary.income, currency)}</strong></div><div><span>Расходы</span><strong className="negative">{formatMoney(summary.expense, currency)}</strong></div><div><span>Разница без переводов</span><strong>{formatMoney(summary.net, currency)}</strong></div></section>{operationList(rows)}</>}
        {!manage && view === 'analytics' && <FinancialAnalytics key={currency} data={data} currency={currency} onCategory={showCategory} onDeposit={item => setDialog({ type: 'accountDetail', item })} />}
        {!manage && view === 'payments' && <section className="panel small-empty">Обязательные платежи будут подключены отдельно.</section>}
      </>}
    </div>
    {dialog?.type === 'import' && data && <KaspiImport data={data} csrf={csrf} onChanged={refresh} onClose={() => setDialog(null)} onUnauthorized={onUnauthorized} />}
    {dialog?.type === 'accountDetail' && detailAccount && <Modal title={detailAccount.name} onClose={() => setDialog(null)}>
      {detailAccount.kind === 'deposit' && data ? <DepositDetails key={detailAccount.id} account={detailAccount} data={data} initialTab={dialog.tab}
        onTransfer={preset => setDialog({ type: 'operation', preset, returnDeposit: detailAccount.id })}
        onOperation={item => setDialog({ type: 'detail', item, returnDeposit: detailAccount.id })}
        onEdit={() => setDialog({ type: 'account', item: detailAccount, returnDeposit: detailAccount.id })} /> : <>
        <div className="detail-hero"><strong>{formatMoney(detailAccount.balance_minor, detailAccount.currency)}</strong><span>{detailAccount.bank_code || (detailAccount.kind === 'cash' ? 'Наличные' : 'Счёт')}</span></div>
        <dl className="detail-list"><div><dt>Начало учёта</dt><dd>{detailAccount.opening_date.split('-').reverse().join('.')}</dd></div></dl>
        <div className="modal-actions"><button className="button secondary" onClick={() => showHistory(detailAccount)}>История</button><button className="button primary" onClick={() => setDialog({ type: 'account', item: detailAccount })}>Изменить</button></div>
      </>}
    </Modal>}
    {dialog?.type === 'account' && <AccountEditor item={dialog.item} initialKind={dialog.initialKind} onSave={save} onClose={close} />}
    {dialog?.type === 'category' && <CategoryEditor item={dialog.item} onSave={save} onClose={close} />}
    {dialog?.type === 'operation' && data && <OperationEditor item={dialog.item} preset={dialog.preset} data={data} onSave={save} onClose={close} />}
    {dialog?.type === 'confirm' && <Confirm actionLabel={dialog.actionLabel} title={dialog.title} description={dialog.description} action={dialog.action} onClose={close} />}
    {dialog?.type === 'detail' && <Modal title="Детали операции" onClose={close}><div className={`detail-hero operation-${dialog.item.kind}`}><strong className="operation-amount">{movement(dialog.item, dialog.returnDeposit ?? account)}</strong><span>{dialog.item.adjustment_type ? (BigInt(dialog.item.expense_correction_minor ?? '0') > 0n ? 'Возврат уменьшает расходы исходной категории в дату поступления' : dialog.item.adjustment_pending ? 'Неподтверждённая корректировка: требуется проверка связи. Учитывается только в остатке' : 'Курсовая корректировка: учитывается в остатке, не является доходом') : dialog.item.kind === 'transfer' ? 'Перевод между своими счетами' : categoryName(dialog.item.category_id)}</span></div><dl className="detail-list"><div><dt>Счёт</dt><dd>{label(dialog.item)}</dd></div><div><dt>Дата</dt><dd>{dialog.item.occurred_on}</dd></div><div><dt>Комментарий</dt><dd>{dialog.item.comment || 'Не указан'}</dd></div></dl><div className="modal-actions"><button className="button danger-text" onClick={() => remove(dialog.item, 'operations')}>Удалить</button><button className="button primary" onClick={() => setDialog({ type: 'operation', item: dialog.item, returnDeposit: dialog.returnDeposit })}><Pencil size={16} />Изменить</button></div></Modal>}
  </Layout>
}
