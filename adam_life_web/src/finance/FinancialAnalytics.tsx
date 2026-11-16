import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import { chartPointIndex } from '../domain/analytics'
import { formatMoney, totals, type Account, type Currency, type Snapshot } from './client'
import { analyticsRanges, analyticsRows, categorySlices, comparisonText, depositGroups, flowPoints, type AnalyticsDrilldown, type AnalyticsPeriod, type CategorySlice, type FlowPoint } from './analytics'
import './analytics.css'

const periods: [AnalyticsPeriod, string][] = [['month', 'Текущий месяц'], ['previous', 'Прошлый месяц'], ['3', 'Последние 3 месяца'], ['6', 'Последние 6 месяцев'], ['12', 'Последние 12 месяцев'], ['custom', 'Выбрать даты']]
const dateLabel = (date: string) => date.split('-').reverse().join('.')
const rangeLabel = (range: { from: string; to: string }) => `${dateLabel(range.from)} — ${dateLabel(range.to)}`
const percentage = (share: number) => new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 1 }).format(share)

/** Same SVG interaction as existing charts; only visual coordinates use Number. */
export function AnalyticsFlow({ points, currency }: { points: FlowPoint[]; currency: Currency }) {
  const [index, setIndex] = useState<number | null>(null)
  if (!points.length) return <p className="small-empty">Нет данных за период.</p>
  const selected = Math.min(index ?? points.length - 1, points.length - 1), active = points[selected]
  const max = points.reduce((n, p) => p.income > n || p.expense > n ? (p.income > p.expense ? p.income : p.expense) : n, 1n)
  const x = (i: number) => 12 + i / Math.max(1, points.length - 1) * 560
  const min = points.reduce((n, p) => p.income < n || p.expense < n ? (p.income < p.expense ? p.income : p.expense) : n, 0n)
  const y = (amount: bigint) => 177 - Number((amount - min) * 10000n / (max - min)) / 10000 * 145
  function select(event: MouseEvent<SVGSVGElement>) {
    const transform = event.currentTarget.getScreenCTM(); if (!transform) return
    const point = event.currentTarget.createSVGPoint(); point.x = event.clientX; point.y = event.clientY
    setIndex(chartPointIndex(point.matrixTransform(transform.inverse()).x, points.length))
  }
  function key(event: KeyboardEvent<SVGSVGElement>) {
    const next = event.key === 'ArrowLeft' ? selected - 1 : event.key === 'ArrowRight' ? selected + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : null
    if (next !== null) { event.preventDefault(); setIndex(Math.max(0, Math.min(points.length - 1, next))) }
  }
  return <section className="panel analytics-flow"><div className="panel-heading"><h2>Динамика доходов и расходов</h2></div>
    <div className="analytics-legend"><span className="positive">● Доходы</span><span className="negative">● Расходы</span></div>
    <div className="analytics-point" aria-live="polite"><span>{active.label}</span><strong className="positive">{formatMoney(active.income, currency)}</strong><strong className="negative">{formatMoney(active.expense, currency)}</strong></div>
    <svg className="flow-svg" viewBox="0 0 590 200" role="slider" tabIndex={0} aria-label="Доходы и расходы: коснитесь графика или используйте стрелки" aria-valuemin={0} aria-valuemax={points.length - 1} aria-valuenow={selected} aria-valuetext={`${active.label}: доходы ${formatMoney(active.income, currency)}, расходы ${formatMoney(active.expense, currency)}`} onClick={select} onKeyDown={key}>
      {[32, 105, 177].map(row => <line key={row} x1="8" x2="580" y1={row} y2={row} className="chart-gridline" />)}
      {(['income', 'expense'] as const).map(kind => <g key={kind} stroke={`var(--${kind === 'income' ? 'positive' : 'negative'})`}><path fill="none" strokeWidth="2" d={points.map((p, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(p[kind])}`).join(' ')} /><circle cx={x(selected)} cy={y(active[kind])} r="5" fill={`var(--${kind === 'income' ? 'positive' : 'negative'})`} /></g>)}
      <line x1={x(selected)} x2={x(selected)} y1="20" y2="187" stroke="var(--line-strong)" strokeDasharray="3 5" />
    </svg><div className="chart-x-labels">{[...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].map(i => <span key={i}>{points[i].label}</span>)}</div>
    {points.every(p => p.income === 0n && p.expense === 0n) && <p className="ledger-hint">Доходов и расходов за период нет.</p>}
  </section>
}

export function AnalyticsCategories({ items, total, currency, kind, mode, onMode, onKind, onCategory }: {
  items: CategorySlice[]; total: bigint; currency: Currency; kind: 'income' | 'expense'; mode: 'bars' | 'donut';
  onMode: (mode: 'bars' | 'donut') => void; onKind: (kind: 'income' | 'expense') => void; onCategory: (id: string | null) => void;
}) {
  const [selected, setSelected] = useState<{ id: string | null } | null>(null)
  const active = selected ? items.find(item => item.id === selected.id) : undefined
  let progress = 0
  const positive = items.filter(item => item.amount > 0n)
  const hasCorrections = items.some(item => item.amount < 0n)
  return <section className="panel analytics-categories"><div className="panel-heading"><h2>{kind === 'expense' ? 'Расходы' : 'Доходы'} по категориям</h2></div>
    <div className="analytics-switches"><div className="chart-switch" role="group" aria-label="Тип категорий">{(['expense', 'income'] as const).map(value => <button key={value} aria-pressed={kind === value} className={kind === value ? 'selected' : ''} onClick={() => { setSelected(null); onKind(value) }}>{value === 'expense' ? 'Расходы' : 'Доходы'}</button>)}</div>
      <div className="chart-switch" role="group" aria-label="Вид диаграммы">{(['bars', 'donut'] as const).map(value => <button key={value} aria-pressed={mode === value} className={mode === value ? 'selected' : ''} onClick={() => onMode(value)}>{value === 'bars' ? 'Столбцы' : 'Круг'}</button>)}</div></div>
    {mode === 'bars' && items.length > 0 && <p className="analytics-category-total">Всего: <strong>{formatMoney(total, currency)}</strong></p>}
    {items.every(item => item.amount === 0n) && <p className="small-empty">{kind === 'expense' ? 'Расходов' : 'Доходов'} за выбранный период нет.</p>}
    {mode === 'donut' && items.some(item => item.amount !== 0n) && <div className="analytics-donut"><svg viewBox="0 0 240 240" aria-label="Категории: выберите сектор">
      <circle cx="120" cy="120" r="96" fill="none" stroke="var(--line)" strokeWidth="26" />
      {positive.map((item, i) => {
        const offset = progress, share = i === positive.length - 1 ? 1 - progress : item.share; progress += share
        return <circle key={item.id ?? 'uncategorized'} cx="120" cy="120" r="96" pathLength="100" fill="none" stroke={item.color} strokeWidth={active?.id === item.id ? 32 : 26} strokeDasharray={`${share * 100} 100`} strokeDashoffset={-offset * 100} transform="rotate(-90 120 120)" opacity={active && active.id !== item.id ? .4 : 1} role="button" tabIndex={0} aria-label={`Выбрать ${item.name}: ${formatMoney(item.amount, currency)}, ${percentage(item.share)}`} aria-pressed={active?.id === item.id} style={{ pointerEvents: 'visibleStroke', cursor: 'pointer' }} onClick={() => setSelected({ id: item.id })} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected({ id: item.id }) } }} />
      })}</svg><div className="analytics-donut-total"><small>{kind === 'expense' ? 'Всего расходов' : 'Всего доходов'}</small><strong>{formatMoney(total, currency)}</strong></div></div>}
    {hasCorrections && <p className="ledger-hint">Возвраты показаны отрицательными суммами и учтены в общем итоге. Доли и сектора рассчитаны только по положительным категориям.</p>}
    {active && <div className="analytics-category-detail" aria-live="polite"><strong>{active.name} · {formatMoney(active.amount, currency)} · {percentage(active.share)}</strong><span>Ранее: {formatMoney(active.previous, currency)} · {comparisonText(active.amount, active.previous)}</span><button className="text-action" onClick={() => onCategory(active.id)}>Операции категории →</button></div>}
    <ul className="analytics-category-list">{items.map(item => <li key={item.id ?? 'uncategorized'}><div className="analytics-category-row"><button className="analytics-category-link" onClick={() => onCategory(item.id)}><i style={{ background: item.color }} /><span>{item.name}</span></button><div><strong>{formatMoney(item.amount, currency)}</strong><small>{item.amount < 0n ? 'Возвраты за период' : percentage(item.share)}</small></div></div>
      {mode === 'bars' && <button className="analytics-bar-button" aria-label={`Подробнее: ${item.name}`} onClick={() => setSelected({ id: item.id })}><span className="analytics-bar-track"><span style={{ width: `${item.share * 100}%`, background: item.color }} /></span></button>}
      <button className="text-action analytics-compare" onClick={() => setSelected({ id: item.id })}>Сравнение</button>
    </li>)}</ul>
  </section>
}

export function AnalyticsDeposits({ accounts, selected, onOpen }: { accounts: Account[]; selected: string[]; onOpen: (account: Account) => void }) {
  const groups = depositGroups(accounts, selected)
  return <section className="panel analytics-deposits"><div className="panel-heading"><h2>Депозиты</h2></div><p className="ledger-hint">Текущие накопления · не доходы за период</p>
    {groups.map(group => <div key={group.currency} className="analytics-deposit-group"><div className="analytics-deposit-total"><span>{group.currency}</span><strong>{formatMoney(group.total, group.currency)}</strong></div>{group.items.map(account => <button key={account.id} className="analytics-deposit-row" onClick={() => onOpen(account)}><span><strong>{account.name}</strong><small>{account.bank_code || 'Банк не указан'}{account.archived ? ' · архив' : ''}</small></span><strong>{formatMoney(account.balance_minor, account.currency)}</strong></button>)}</div>)}
    {!groups.length && <p className="small-empty">Нет депозитов для выбранных счетов.</p>}
  </section>
}

export function FinancialAnalytics({ data, currency, onCategory, onDeposit }: { data: Snapshot; currency: Currency; onCategory: (filter: AnalyticsDrilldown) => void; onDeposit: (account: Account) => void }) {
  const [period, setPeriod] = useState<AnalyticsPeriod>('month'), [accounts, setAccounts] = useState<string[]>([])
  const [custom, setCustom] = useState({ from: data.as_of.slice(0, 7) + '-01', to: data.as_of })
  const [kind, setKind] = useState<'income' | 'expense'>('expense'), [mode, setMode] = useState<'bars' | 'donut'>('bars')
  const ranges = analyticsRanges(period, data.as_of, custom)
  const filter = { currency, accounts }, rows = ranges ? analyticsRows(data.operations, { ...filter, ...ranges.current }) : []
  const previous = ranges ? analyticsRows(data.operations, { ...filter, ...ranges.previous }) : [], summary = totals(rows), prior = totals(previous)
  const categories = categorySlices(rows, previous, data.categories, kind)
  const chartKey = `${currency}:${accounts.join(',')}:${ranges?.current.from}:${ranges?.current.to}`
  return <div className="financial-analytics"><div className="analytics-filters"><label className="field"><span>Период</span><select value={period} onChange={e => setPeriod(e.target.value as AnalyticsPeriod)}>{periods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <details className="analytics-account-filter"><summary>{accounts.length === 0 ? 'Все счета' : accounts.length === 1 ? data.accounts.find(a => a.id === accounts[0])?.name : `Выбрано счетов: ${accounts.length}`}</summary><div><button className="text-action" onClick={() => setAccounts([])}>Все счета</button>{data.accounts.filter(a => a.currency === currency).map(a => <label className="ledger-check" key={a.id}><input type="checkbox" checked={accounts.includes(a.id)} onChange={e => setAccounts(e.target.checked ? [...accounts, a.id] : accounts.filter(id => id !== a.id))} />{a.name}{a.archived ? ' · архив' : ''}</label>)}</div></details>
    {period === 'custom' && <div className="analytics-custom"><label className="field"><span>С даты</span><input type="date" value={custom.from} onChange={e => setCustom({ ...custom, from: e.target.value })} /></label><label className="field"><span>По дату</span><input type="date" value={custom.to} onChange={e => setCustom({ ...custom, to: e.target.value })} /></label></div>}</div>
    {!ranges ? <p role="alert" className="form-error">Укажите корректные даты: начало не позже окончания.</p> : <>
      <p className="ledger-hint analytics-period-label">{rangeLabel(ranges.current)}<br />Сравнение: {rangeLabel(ranges.previous)}</p>
      <div className="analytics-summary">{(['income', 'expense'] as const).map(type => <article className="panel" key={type}><span>{type === 'income' ? 'Доходы' : 'Расходы'}</span><strong className={type === 'income' ? 'positive' : 'negative'}>{formatMoney(summary[type], currency)}</strong><small>{comparisonText(summary[type], prior[type])}</small></article>)}<article className="panel analytics-net"><span>Разница доходов и расходов</span><strong className={summary.net < 0n ? 'negative' : summary.net > 0n ? 'positive' : ''}>{formatMoney(summary.net, currency)}</strong></article></div>
      <AnalyticsFlow key={chartKey} points={flowPoints(rows, ranges.current)} currency={currency} />
      <AnalyticsCategories key={chartKey} items={categories} total={summary[kind]} currency={currency} kind={kind} mode={mode} onMode={setMode} onKind={setKind} onCategory={category => onCategory({ ...filter, ...ranges.current, category, kind })} />
    </>}
    <AnalyticsDeposits accounts={data.accounts} selected={accounts} onOpen={onDeposit} />
  </div>
}
