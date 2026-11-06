import { useEffect, useRef, useState } from 'react'
import { ArrowLeftRight, Banknote, CreditCard, LogOut, Pencil, Plus, Wallet } from 'lucide-react'
import { Layout, navigation } from '../components/Layout'
import { Modal } from '../components/Dialogs'
import { localDate, type View } from '../domain/finance'
import type { Session } from '../auth/client'
import { AccountEditor, CategoryEditor, Confirm, OperationEditor } from './Editors'
import { FinanceError, depositDetails, filterOperations, financeRequest, formatMoney, movement, totals, type Account, type Category, type Currency, type Operation, type Snapshot } from './client'
import { DepositComparison } from './DepositHistoryViews'
import { DepositInsights } from './DepositInsights'
import { DepositPlan } from './DepositPlan'
import { SavingsGoals } from './SavingsGoals'
import './finance.css'

type Dialog = { type: 'accountDetail'; item: Account } | { type: 'account'; item?: Account } | { type: 'category'; item?: Category } | { type: 'operation'; item?: Operation } | { type: 'detail'; item: Operation } | { type: 'confirm'; title: string; description: string; action: () => Promise<void> } | null
export function FinancialWorkspace({ session, onLogout, onUnauthorized }: { session: Session; onLogout: () => void; onUnauthorized: () => void }) {
  const [data, setData] = useState<Snapshot | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const [view, setView] = useState<View>('overview'), [manage, setManage] = useState<'accounts' | 'categories' | 'goals' | null>(null), [dialog, setDialog] = useState<Dialog>(null)
  const [currency, setCurrency] = useState<Currency>('KZT'), [account, setAccount] = useState(''), [kind, setKind] = useState(''), [category, setCategory] = useState('')
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
  const close = () => setDialog(null)
  function navigate(next: View) { setView(next); setManage(null); close(); window.scrollTo({ top: 0, behavior: 'instant' }) }
  const rows = data ? filterOperations(data.operations, { currency, account, kind, category, from, to }) : []
  const monthly = data ? totals(filterOperations(data.operations, { currency, account: '', kind: '', category: '', from: data.as_of.slice(0, 7) + '-01', to: data.as_of })) : totals([])
  const summary = totals(rows), balance = data?.balances[currency]
  const name = (id: string | null) => data?.accounts.find(a => a.id === id)?.name ?? 'Счёт'
  const categoryName = (id: string | null) => data?.categories.find(c => c.id === id)?.name ?? 'Перевод'
  const label = (row: Operation) => row.kind === 'transfer' ? `${name(row.account_id)} → ${name(row.destination_account_id)}` : name(row.account_id)
  const add = () => setDialog(data?.accounts.some(a => !a.archived) ? { type: 'operation' } : { type: 'account' })
  function showHistory(a: Account) { setCurrency(a.currency); setAccount(a.id); setFrom(''); setTo(''); setKind(''); setCategory(''); navigate('transactions') }
  function archiveItem(item: Account | Category, type: 'accounts' | 'categories') {
    setDialog({ type: 'confirm', title: item.archived ? 'Восстановить из архива?' : 'Архивировать?', description: 'История и остатки сохраняются. Новые операции доступны только для активных счетов и категорий.',
      action: () => save(`${type}/${item.id}`, 'PUT', { ...(type === 'accounts' ? { name: item.name, kind: item.kind, bank_code: (item as Account).bank_code, currency: (item as Account).currency, opening_balance_minor: (item as Account).opening_balance_minor, opening_date: (item as Account).opening_date } : { name: item.name, kind: item.kind }), archived: !item.archived, expected_version: item.version }) })
  }
  function remove(item: Account | Category | Operation, type: 'accounts' | 'categories' | 'operations') {
    setDialog({ type: 'confirm', title: 'Удалить запись?', description: type === 'operations' ? 'Баланс затронутых счетов будет пересчитан. Действие останется в аудите.' : 'Удаление доступно только без истории операций. Начальный остаток удаляемого счёта также исключается из общего баланса.', action: () => save(`${type}/${item.id}`, 'DELETE', { expected_version: item.version }) })
  }
  function operationList(items: Operation[]) {
    return <section className="panel ledger-history"><div className="panel-heading"><h2>{view === 'overview' ? 'Последние операции' : 'История операций'}</h2>{view === 'overview' && <button className="text-action" onClick={() => navigate('transactions')}>Все операции</button>}</div>
      {!items.length && <div className="small-empty">Операций пока нет. Добавьте доход, расход или перевод.</div>}
      {items.map(row => <button key={row.id} className="ledger-row" onClick={() => setDialog({ type: 'detail', item: row })}><span className="account-symbol">{row.kind === 'transfer' ? <ArrowLeftRight size={18} /> : <Wallet size={18} />}</span><span className="ledger-row-copy"><strong>{row.kind === 'transfer' ? 'Перевод' : categoryName(row.category_id)}</strong><small>{label(row)} · {row.occurred_on.split('-').reverse().join('.')}</small>{row.comment && <small>{row.comment}</small>}</span><strong className={row.kind === 'income' ? 'positive' : row.kind === 'expense' ? 'negative' : ''}>{movement(row, view === 'transactions' ? account : '')}</strong></button>)}
    </section>
  }
  return <Layout view={view} onNavigate={navigate} onAdd={data ? add : undefined} accountControl={<button className="button secondary auth-logout" onClick={onLogout}><LogOut size={16} />Выйти</button>}>
    <div className="page-content ledger"><header className="page-header"><div><h1>{manage === 'accounts' ? 'Мои счета' : manage === 'categories' ? 'Категории' : manage === 'goals' ? 'Цели накопления' : navigation.find(n => n.id === view)?.title}</h1><p>{session.user.display_name}</p></div>{data && <button className="button primary desktop-add" onClick={add}><Plus size={17} />Добавить операцию</button>}</header>
      <div className="ledger-tools"><button className="button secondary" onClick={() => { setManage(manage === 'accounts' ? null : 'accounts'); setArchive(false) }}>Счета</button><button className="button secondary" onClick={() => { setManage(manage === 'categories' ? null : 'categories'); setArchive(false) }}>Категории</button><button className="button secondary" onClick={() => setManage(manage === 'goals' ? null : 'goals')}>Цели</button><label className="field"><span className="sr-only">Валюта сводки</span><select aria-label="Валюта сводки" value={currency} onChange={e => { setCurrency(e.target.value as Currency); setAccount('') }}>{['KZT', 'USD', 'EUR'].map(c => <option key={c}>{c}</option>)}</select></label><button className="text-action" onClick={() => void refresh().catch(e => { if (e instanceof FinanceError && e.status === 401) unauthorized.current(); else setError('Не удалось обновить данные') })}>Обновить</button></div>
      {loading && <p role="status">Загружаем ваши финансы…</p>}{error && <p role="alert" className="form-error">{error}</p>}
      {data && <>
        {manage === 'goals' && <SavingsGoals csrf={csrf} ledger={data} onUnauthorized={onUnauthorized} />}
        {(manage === 'accounts' || manage === 'categories') && <><div className="panel-heading"><h2>{manage === 'accounts' ? 'Счета пользователя' : 'Доходы и расходы'}</h2><button className="button primary" onClick={() => setDialog({ type: manage === 'accounts' ? 'account' : 'category' })}><Plus size={16} />Добавить</button></div><label className="ledger-check"><input type="checkbox" checked={archive} onChange={e => setArchive(e.target.checked)} />Показать архив</label>
          {manage === 'accounts' && <DepositComparison data={data} />}
          <div className="ledger-management">{(manage === 'accounts' ? data.accounts : data.categories).filter(i => archive || !i.archived).map(item => <article className="panel ledger-item" key={item.id}><div><h3>{item.name}{item.archived ? ' · архив' : ''}</h3><p>{'balance_minor' in item ? `${item.bank_code ?? ''} · ${item.kind === 'deposit' ? 'Депозит' : item.kind === 'cash' ? 'Наличные' : 'Банковский счёт'}` : item.kind === 'income' ? 'Доходы' : 'Расходы'}</p>{'balance_minor' in item && <strong>{formatMoney(item.balance_minor, item.currency)}</strong>}</div><div className="ledger-item-actions">{'balance_minor' in item && <><button className="text-action" onClick={() => setDialog({ type: 'accountDetail', item })}>Подробнее</button><button className="text-action" onClick={() => showHistory(item)}>История</button></>}<button className="text-action" onClick={() => setDialog('balance_minor' in item ? { type: 'account', item } : { type: 'category', item })}>Изменить</button><button className="text-action" onClick={() => archiveItem(item, manage)}>{item.archived ? 'Восстановить' : 'В архив'}</button><button className="text-action danger-text" onClick={() => remove(item, manage)}>Удалить</button></div></article>)}</div>
          {manage === 'accounts' && !data.accounts.length && <p className="small-empty">Добавьте свой первый счёт. Начните с остатка на выбранную дату.</p>}</>}
        {!manage && view === 'overview' && <>
          <section className="summary-panel home-summary"><div className="balance-metric"><div className="metric-label">Общий баланс · {currency}</div><div className="balance-value">{formatMoney(balance?.total_minor ?? '0', currency)}</div><span className="balance-subtitle">Включая архивные счета · валюты учитываются отдельно</span></div><div className="summary-metric"><div className="metric-label">Доходы за месяц</div><strong className="metric-value positive">{formatMoney(monthly.income, currency)}</strong></div><div className="summary-metric"><div className="metric-label">Расходы за месяц</div><strong className="metric-value negative">{formatMoney(monthly.expense, currency)}</strong></div></section>
          <div className="ledger-split"><article className="panel"><span>Текущие счета и наличные</span><strong>{formatMoney(balance?.current_minor ?? '0', currency)}</strong></article><article className="panel"><span>На депозитах</span><strong>{formatMoney(balance?.deposit_minor ?? '0', currency)}</strong></article></div>
          <section className="accounts-section"><div className="panel-heading"><h2>Мои счета · {currency}</h2><button className="text-action" onClick={() => setDialog({ type: 'account' })}>Добавить счёт</button></div><div className="account-grid">{data.accounts.filter(a => a.currency === currency).map(a => <button className="account-card" key={a.id} onClick={() => setDialog({ type: 'accountDetail', item: a })}><span className="account-symbol">{a.kind === 'cash' ? <Banknote size={19} /> : <CreditCard size={19} />}</span><span>{a.name}{a.archived ? ' · архив' : ''}</span><strong>{formatMoney(a.balance_minor, a.currency)}</strong></button>)}</div>{!data.accounts.some(a => a.currency === currency) && <div className="small-empty">Нет счетов в {currency}. Добавьте счёт или выберите другую валюту.</div>}</section>
          {operationList(data.operations.filter(o => o.currency === currency).slice(0, 5))}
        </>}
        {!manage && view === 'transactions' && <><div className="ledger-filters"><label className="field"><span>Счёт</span><select value={account} onChange={e => setAccount(e.target.value)}><option value="">Все счета</option>{data.accounts.filter(a => a.currency === currency).map(a => <option value={a.id} key={a.id}>{a.name}{a.archived ? ' · архив' : ''}</option>)}</select></label><label className="field"><span>Тип</span><select value={kind} onChange={e => { setKind(e.target.value); setCategory('') }}><option value="">Все операции</option><option value="income">Доход</option><option value="expense">Расход</option><option value="transfer">Перевод</option></select></label><label className="field"><span>Категория</span><select value={category} onChange={e => setCategory(e.target.value)}><option value="">Все категории</option>{data.categories.filter(c => !kind || kind === c.kind).map(c => <option key={c.id} value={c.id}>{c.name} · {c.kind === 'income' ? 'доход' : 'расход'}</option>)}</select></label><label className="field"><span>С даты</span><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label className="field"><span>По дату</span><input type="date" value={to} onChange={e => setTo(e.target.value)} /></label><button className="text-action" onClick={() => { setFrom(''); setTo('') }}>Всё время</button></div><section className="filter-summary"><div><span>Найдено операций</span><strong>{rows.length}</strong></div><div><span>Доходы</span><strong className="positive">{formatMoney(summary.income, currency)}</strong></div><div><span>Расходы</span><strong className="negative">{formatMoney(summary.expense, currency)}</strong></div><div><span>Разница без переводов</span><strong>{formatMoney(summary.net, currency)}</strong></div></section>{operationList(rows)}</>}
        {!manage && (view === 'analytics' || view === 'payments') && <section className="panel small-empty">{view === 'analytics' ? 'Расширенная аналитика будет подключена следующим этапом. Балансы и операции доступны на Главной.' : 'Обязательные платежи будут подключены отдельно.'}</section>}
      </>}
    </div>
    {dialog?.type === 'accountDetail' && <Modal title={dialog.item.name} onClose={close}><div className="detail-hero"><strong>{formatMoney(dialog.item.balance_minor, dialog.item.currency)}</strong><span>{dialog.item.bank_code || (dialog.item.kind === 'cash' ? 'Наличные' : 'Счёт')}</span></div><dl className="detail-list">{depositDetails(dialog.item).filter(([label]) => label !== 'Годовая ставка' && label !== 'Дата окончания').map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}<div><dt>Начало учёта</dt><dd>{dialog.item.opening_date.split('-').reverse().join('.')}</dd></div></dl>{dialog.item.kind === 'deposit' && data && <><DepositInsights key={dialog.item.id} accountId={dialog.item.id} data={data} /><DepositPlan key={'plan-' + dialog.item.id} account={dialog.item} ledger={data} csrf={csrf} onUnauthorized={onUnauthorized} /></>}<div className="modal-actions"><button className="button secondary" onClick={() => showHistory(dialog.item)}>История</button><button className="button primary" onClick={() => setDialog({ type: 'account', item: dialog.item })}>Изменить</button></div></Modal>}
    {dialog?.type === 'account' && <AccountEditor item={dialog.item} onSave={save} onClose={close} />}
    {dialog?.type === 'category' && <CategoryEditor item={dialog.item} onSave={save} onClose={close} />}
    {dialog?.type === 'operation' && data && <OperationEditor item={dialog.item} data={data} onSave={save} onClose={close} />}
    {dialog?.type === 'confirm' && <Confirm title={dialog.title} description={dialog.description} action={dialog.action} onClose={close} />}
    {dialog?.type === 'detail' && <Modal title="Детали операции" onClose={close}><div className="detail-hero"><strong>{movement(dialog.item, account)}</strong><span>{dialog.item.kind === 'transfer' ? 'Перевод между своими счетами' : categoryName(dialog.item.category_id)}</span></div><dl className="detail-list"><div><dt>Счёт</dt><dd>{label(dialog.item)}</dd></div><div><dt>Дата</dt><dd>{dialog.item.occurred_on}</dd></div><div><dt>Комментарий</dt><dd>{dialog.item.comment || 'Не указан'}</dd></div></dl><div className="modal-actions"><button className="button danger-text" onClick={() => remove(dialog.item, 'operations')}>Удалить</button><button className="button primary" onClick={() => setDialog({ type: 'operation', item: dialog.item })}><Pencil size={16} />Изменить</button></div></Modal>}
  </Layout>
}
