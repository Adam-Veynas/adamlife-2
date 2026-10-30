import { ArrowDownLeft, ArrowRight, ArrowUpRight, Banknote, CreditCard, Eye, EyeOff, FileUp, Wallet } from 'lucide-react'
import { useState } from 'react'
import { accountBalances, accountNames, categoryTotals, filterPeriod, expenseCategories, incomeCategories, money, operationCount, periodBounds, queryTransactions, totals, type FinanceFilter, type OperationFilter, type PrototypeData, type Transaction } from '../domain/finance'
import { paymentOccurrences, type PaymentOccurrence } from '../domain/payments'
import { CategoryBreakdown, CashFlowChart, MonthlyComparison } from './Charts'
import { FinanceFilters, periodCaption } from './FinanceFilters'
import { SearchField, TransactionList } from './TransactionList'
import { PaymentRows } from './Payments'

interface Actions { onAdd: () => void; onImport: () => void; onOpen: (item: Transaction) => void }
export function Home({ data, onAdd, onImport, onOpen, onOperations, onPayments, onPayment }: Actions & { data: PrototypeData; onOperations: () => void; onPayments: () => void; onPayment: (row: PaymentOccurrence) => void }) {
  const [hidden, setHidden] = useState(false)
  const now = new Date(), summary = totals(filterPeriod(data.transactions, now, 'month'))
  const accounts = accountBalances(data), balance = accounts.reduce((sum, account) => sum + account.balance, 0)
  const recent = filterPeriod(data.transactions, now, 'all').slice(0, 4)
  const upcoming = paymentOccurrences(data.payments ?? [], now).filter(row => row.status !== 'paid').slice(0, 3)
  return <>
    <section className="summary-panel home-summary" aria-label="Финансовая сводка"><div className="balance-metric"><div className="metric-label">Общий баланс <button className="icon-button" aria-label={hidden ? 'Показать баланс' : 'Скрыть баланс'} onClick={() => setHidden(!hidden)}>{hidden ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><div className={`balance-value ${balance < 0 ? 'negative' : ''}`}>{hidden ? '••• •••' : money(balance)}</div><span className="balance-subtitle">На всех счетах</span></div><div className="summary-metric"><div className="metric-label"><ArrowDownLeft size={16} />Доходы за месяц</div><strong className="metric-value positive">{money(summary.income)}</strong></div><div className="summary-metric"><div className="metric-label"><ArrowUpRight size={16} />Расходы за месяц</div><strong className="metric-value negative">{money(summary.expense)}</strong></div></section>
    <section className="accounts-section" aria-label="Мои счета"><h2 className="section-title">Мои счета</h2><div className="account-grid">{accounts.map(account => <article className="account-card" key={account.id}><span className="account-symbol">{account.id === 'cash' ? <Banknote size={19} /> : <CreditCard size={19} />}</span><span>{accountNames[account.id]}</span><strong className={account.balance < 0 ? 'negative' : ''}>{hidden ? '•••' : money(account.balance)}</strong></article>)}</div></section>
    <div className="home-columns"><section className="panel upcoming-panel"><div className="panel-heading"><h2>Ближайшие платежи</h2><button className="text-action" onClick={onPayments}>Все <ArrowRight size={15} /></button></div>{upcoming.length ? <PaymentRows rows={upcoming} onOpen={onPayment} compact /> : <div className="small-empty">Все платежи месяца оплачены</div>}</section><section className="panel quick-actions"><h2>Выписка</h2><button onClick={onImport}><span><FileUp size={21} /></span><div><strong>Импорт PDF</strong><small>Проверить выписку</small></div><ArrowRight size={17} /></button></section></div>
    <TransactionList items={recent} onOpen={onOpen} onAdd={onAdd} onSeeAll={onOperations} />
  </>
}
export function FilterSummary({ items, caption, title, net = false }: { items: Transaction[]; caption: string; title?: string; net?: boolean }) {
  const sum = totals(items)
  return <section className="filter-summary" aria-label="Сводка за выбранный период"><div className="filter-context"><strong>{title ?? caption}</strong><span>{title ? `${caption} · ` : ''}Найдено: {operationCount(items.length)}</span></div><div><span>Доходы</span><strong className="positive">{money(sum.income)}</strong></div><div><span>Расходы</span><strong className="negative">{money(sum.expense)}</strong></div>{net && <div><span>Разница</span><strong className={sum.net >= 0 ? 'positive' : 'negative'}>{money(sum.net, { sign: true })}</strong></div>}</section>
}
export function Operations({ items, filter, onFilter, onAdd, onOpen }: Actions & { items: Transaction[]; filter: OperationFilter; onFilter: (filter: OperationFilter) => void }) {
  const filtered = queryTransactions(items, filter)
  const categories = filter.kind === 'income' ? incomeCategories : filter.kind === 'expense' ? expenseCategories : filter.kind === 'transfer' ? ['Перевод'] : [...new Set([...expenseCategories, ...incomeCategories])]
  return <><FinanceFilters filter={filter} onChange={value => onFilter({ ...filter, ...value })} />
    <div className="operations-controls"><SearchField value={filter.query ?? ''} onChange={query => onFilter({ ...filter, query })} /><div className="type-filters" role="group" aria-label="Тип операций">{([['all', 'Все'], ['expense', 'Расходы'], ['income', 'Доходы'], ['transfer', 'Переводы']] as const).map(([kind, label]) => <button key={kind} className={filter.kind === kind ? 'selected' : ''} aria-pressed={filter.kind === kind} onClick={() => onFilter({ ...filter, kind, category: '' })}>{label}</button>)}</div><label className="sort-select"><span className="sr-only">Сортировка</span><select aria-label="Сортировка" value={filter.sort} onChange={event => onFilter({ ...filter, sort: event.target.value as OperationFilter['sort'] })}><option value="date-desc">Сначала новые</option><option value="date-asc">Сначала старые</option><option value="amount-desc">Сумма: по убыванию</option><option value="amount-asc">Сумма: по возрастанию</option></select></label></div>
    <div className="category-filter-row"><label className="field category-filter"><span>Категория</span><select aria-label="Категория операций" value={filter.category ?? ''} onChange={event => onFilter({ ...filter, category: event.target.value })}><option value="">Все категории</option>{filter.category && !categories.includes(filter.category) && <option>{filter.category}</option>}{categories.map(category => <option key={category}>{category}</option>)}</select></label>{filter.category && <button className="text-action" onClick={() => onFilter({ ...filter, category: '' })}>Сбросить категорию</button>}</div>
    <FilterSummary items={filtered} caption={periodCaption(filter)} title={filter.category || undefined} />
    <div className="history-heading"><h2>История операций</h2></div><TransactionList all grouped={!filter.sort?.startsWith('amount')} items={filtered} onOpen={onOpen} onAdd={onAdd} />
  </>
}
export function Analytics({ items, filter, onFilter, onCategory }: { items: Transaction[]; filter: FinanceFilter; onFilter: (filter: FinanceFilter) => void; onCategory: (category: string) => void }) {
  const filtered = queryTransactions(items, filter), accounts = queryTransactions(items, { ...filter, period: 'all' })
  const { days } = periodBounds(filtered, filter.month, filter.period)
  const categories = categoryTotals(filtered), sum = totals(filtered)
  return <><FinanceFilters filter={filter} onChange={onFilter} /><FilterSummary items={filtered.filter(row => row.type !== 'transfer')} caption={periodCaption(filter)} net />
    <MonthlyComparison key={`${filter.month.getTime()}-${filter.account}`} items={accounts} month={filter.month} />
    <div className="analytics-grid"><CategoryBreakdown key={`categories-${filter.month.getTime()}-${filter.period}-${filter.account}`} items={filtered} allItems={accounts} month={filter.month} period={filter.period} onCategory={onCategory} /><CashFlowChart key={`flow-${filter.month.getTime()}-${filter.period}-${filter.account}`} items={filtered} month={filter.month} period={filter.period} /></div>
    <div className="insight-grid"><article className="panel insight"><Wallet size={20} /><div><span>Средние расходы в день</span><strong>{money(Math.round(sum.expense / days))}</strong><small>{days} календарных дней в расчёте</small></div></article><article className="panel insight"><ArrowUpRight size={20} /><div><span>Самая затратная категория</span><strong>{categories[0]?.name ?? 'Нет расходов'}</strong><small>{categories[0] ? `${money(categories[0].amount)} · ${Math.round(categories[0].share * 100)}% расходов` : 'За выбранный период'}</small></div></article></div>
  </>
}
