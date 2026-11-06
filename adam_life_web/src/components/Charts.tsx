import { useState, type MouseEvent, type KeyboardEvent } from 'react'
import { ArrowRight } from 'lucide-react'
import { categoryColor } from '../theme/palettes'
import { categoryTotals, dailySeries, dateLabel, filterPeriod, money, monthLabel, monthlySeries, shiftMonth, totals, type Period, type Transaction } from '../domain/finance'
import { categoryComparison, chartPointIndex, spendingComparison } from '../domain/analytics'

/** Uses the existing chart interaction and tokens; monetary values stay exact BigInt. */
export function BalanceHistoryChart({ points, format }: { points: { date: string; label: string; amount: bigint }[]; format: (amount: bigint) => string }) {
  const [active, setActive] = useState<number | null>(null)
  if (!points.length) return <p className="ledger-hint">Нет данных для графика.</p>
  const selected = Math.min(active ?? points.length - 1, points.length - 1)
  const min = points.reduce((value, p) => p.amount < value ? p.amount : value, points[0].amount)
  const max = points.reduce((value, p) => p.amount > value ? p.amount : value, points[0].amount)
  const coords = points.map((p, i) => ({ x: 12 + i / Math.max(1, points.length - 1) * 560,
    y: max === min ? 105 : 177 - Number((p.amount - min) * 10000n / (max - min)) / 10000 * 145 }))
  const path = coords.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')
  const valueText = `${points[selected].date.split('-').reverse().join('.')}: ${format(points[selected].amount)}`
  function selectPoint(event: MouseEvent<SVGSVGElement>) {
    const transform = event.currentTarget.getScreenCTM()
    if (!transform) return
    const point = event.currentTarget.createSVGPoint(); point.x = event.clientX; point.y = event.clientY
    setActive(chartPointIndex(point.matrixTransform(transform.inverse()).x, points.length))
  }
  function selectKey(event: KeyboardEvent<SVGSVGElement>) {
    const next = event.key === 'ArrowLeft' ? selected - 1 : event.key === 'ArrowRight' ? selected + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : null
    if (next !== null) { event.preventDefault(); setActive(Math.max(0, Math.min(points.length - 1, next))) }
  }
  return <div className="deposit-balance-chart"><div className="chart-summary" aria-live="polite"><strong>{format(points[selected].amount)}</strong><span>На {points[selected].date.split('-').reverse().join('.')}</span></div>
    <svg className="flow-svg" viewBox="0 0 590 200" role="slider" tabIndex={0} aria-label="Остаток по месяцам: коснитесь графика или используйте стрелки" aria-valuemin={0} aria-valuemax={points.length - 1} aria-valuenow={selected} aria-valuetext={valueText} onClick={selectPoint} onKeyDown={selectKey}>
      {[32, 105, 177].map(y => <line key={y} x1="8" x2="580" y1={y} y2={y} className="chart-gridline" />)}
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
      <line x1={coords[selected].x} x2={coords[selected].x} y1="20" y2="187" stroke="var(--line-strong)" strokeDasharray="3 5" />
      {coords.map((p, i) => <circle key={points[i].date} cx={p.x} cy={p.y} r={i === selected ? 5 : 3} fill="var(--accent)"><title>{`${points[i].label}: ${format(points[i].amount)}`}</title></circle>)}
    </svg><div className="chart-x-labels">{[...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].map(i => <span key={i}>{points[i].label}</span>)}</div>
    <label className="chart-scrubber"><span>Выбрать месяц</span><input type="range" aria-label="Месяц на графике остатка" min={0} max={points.length - 1} value={selected} onChange={e => setActive(Number(e.target.value))} /></label>
  </div>
}

export function CashFlowChart({ items, month, period }: { items: Transaction[]; month: Date; period: Period }) {
  const [type, setType] = useState<'income' | 'expense'>('expense')
  const [cumulative, setCumulative] = useState(false)
  const [active, setActive] = useState<number | null>(null)
  const points = dailySeries(items, month, period, type, cumulative)
  const max = Math.max(...points.map(point => point.amount), 100)
  const selected = Math.min(active ?? points.length - 1, points.length - 1)
  const coords = points.map((point, index) => ({ x: 12 + index / Math.max(1, points.length - 1) * 560, y: 177 - point.amount / max * 145 }))
  const path = coords.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')
  const selectedPoint = points[selected]
  function selectPoint(event: MouseEvent<SVGSVGElement>) {
    const transform = event.currentTarget.getScreenCTM()
    if (!transform) return
    const point = event.currentTarget.createSVGPoint()
    point.x = event.clientX; point.y = event.clientY
    setActive(chartPointIndex(point.matrixTransform(transform.inverse()).x, points.length))
  }
  function selectWithKeyboard(event: KeyboardEvent<SVGSVGElement>) {
    const next = event.key === 'ArrowLeft' ? selected - 1 : event.key === 'ArrowRight' ? selected + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : null
    if (next !== null) { event.preventDefault(); setActive(Math.max(0, Math.min(points.length - 1, next))) }
  }
  return <section className="panel cashflow-panel" data-flow={type}><div className="panel-heading"><h2>Динамика расходов и доходов</h2></div>
    <div className="flow-controls"><div className="chart-switch" role="group" aria-label="Показатель графика">{(['expense', 'income'] as const).map(value => <button key={value} className={type === value ? 'selected' : ''} aria-pressed={type === value} onClick={() => { setType(value); setActive(null) }}>{value === 'expense' ? 'Расходы' : 'Доходы'}</button>)}</div><div className="chart-switch" role="group" aria-label="Режим графика">{[false, true].map(value => <button key={String(value)} className={cumulative === value ? 'selected' : ''} aria-pressed={cumulative === value} onClick={() => { setCumulative(value); setActive(null) }}>{value ? 'Накопительно' : 'По дням'}</button>)}</div></div>
    <div className="chart-summary" aria-live="polite"><strong>{money(active === null ? totals(items)[type] : selectedPoint.amount)}</strong><span>{active === null ? 'за выбранный период' : `${dateLabel(selectedPoint.date)}${cumulative ? ' · накопительно' : ''}`}</span></div>
    <div className="chart-container"><div className="chart-y-labels">{[1, .5, 0].map(value => <span key={value}>{money(Math.round(max * value), { compact: true })}</span>)}</div><div className="chart-plot"><svg className="flow-svg" viewBox="0 0 590 200" role="img" tabIndex={0} aria-label="График по дням. Нажмите на точку или используйте стрелки клавиатуры" onClick={selectPoint} onKeyDown={selectWithKeyboard}>{[32, 105, 177].map(y => <line key={y} x1="8" x2="580" y1={y} y2={y} className="chart-gridline" />)}<path d={`${path} L 572 187 L 12 187 Z`} fill="var(--chart-color)" opacity=".06" /><path d={path} fill="none" stroke="var(--chart-color)" strokeWidth="2" strokeLinejoin="round" />{active !== null && <><line x1={coords[selected].x} x2={coords[selected].x} y1="20" y2="187" stroke="var(--line-strong)" strokeDasharray="3 5" /><circle cx={coords[selected].x} cy={coords[selected].y} r="5" fill="var(--chart-color)" stroke="var(--surface)" strokeWidth="2" /></>}{coords.map((point, index) => <circle key={points[index].date} cx={point.x} cy={point.y} r={active === index ? 5 : 2.7} fill="var(--chart-color)" opacity={active === index ? 1 : .65}><title>{`${dateLabel(points[index].date)}: ${money(points[index].amount)}`}</title></circle>)}</svg><div className="chart-x-labels">{[...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].map(index => <span key={index}>{dateLabel(points[index].date)}</span>)}</div></div></div>
    <label className="chart-scrubber"><span>Выбрать день <strong>{active === null ? 'Коснитесь графика' : dateLabel(selectedPoint.date)}</strong></span><input type="range" aria-label="День на графике" min="0" max={points.length - 1} value={selected} onChange={event => setActive(Number(event.target.value))} /></label>
  </section>
}

export function CategoryBreakdown({ items, allItems, month, period = 'month', onCategory }: { items: Transaction[]; allItems: Transaction[]; month: Date; period?: Period; onCategory: (category: string) => void }) {
  const categories = categoryTotals(items), total = totals(items).expense
  const [selected, setSelected] = useState<string | null>(null)
  const active = categories.find(item => item.name === selected)
  const comparison = active ? categoryComparison(allItems, { month, period, account: 'all' }, active.name) : null
  let progress = 0
  return <section className="panel category-panel detailed"><div className="panel-heading"><h2>Структура расходов</h2><span className="muted">₸</span></div><div className="category-donut-summary"><svg viewBox="0 0 144 144" className="donut" aria-label="Выбор категории расходов"><circle cx="72" cy="72" r="57" fill="none" stroke="var(--line)" strokeWidth="13" />{categories.map(item => {
    const offset = progress; progress += item.share * 358.14
    return <circle key={item.name} cx="72" cy="72" r="57" fill="none" stroke={categoryColor(item.name)} strokeWidth={active?.name === item.name ? 18 : 13} opacity={active && active.name !== item.name ? .35 : 1} strokeDasharray={`${Math.max(item.share * 358.14 - 2, .1)} 358.14`} strokeDashoffset={-offset} transform="rotate(-90 72 72)" style={{ cursor: 'pointer', pointerEvents: 'visibleStroke' }} tabIndex={0} role="button" aria-label={`Выбрать ${item.name}`} onClick={() => setSelected(item.name)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(item.name) } }} />
  })}<text x="72" y="72" textAnchor="middle" className="donut-value">{active ? `${Math.round(active.share * 100)}%` : categories.length}</text><text x="72" y="91" textAnchor="middle" className="donut-label">{active ? 'от расходов' : 'категорий'}</text></svg><div className="donut-description"><span>{active?.name ?? 'Всего потрачено'}</span><strong>{money(active?.amount ?? total)}</strong><small>{active ? 'За выбранный период' : 'Выберите категорию'}</small></div></div>
    {active && <div className="category-selection"><span>{comparison?.previousLabel && <>Предыдущий период: {comparison.previousLabel} · {money(comparison.previousMinor ?? 0)}<br /></>}{comparison?.message}</span><button className="text-action" onClick={() => onCategory(active.name)}>Операции: {active.name}<ArrowRight size={15} /></button></div>}
    <ul className="category-list">{categories.map(item => <li key={item.name}><button className={active?.name === item.name ? 'chosen' : ''} aria-pressed={active?.name === item.name} onClick={() => setSelected(item.name)}><span className="category-dot" style={{ background: categoryColor(item.name) }} /><span className="category-list-name">{item.name}</span><span>{money(item.amount)}</span><small>{Math.round(item.share * 100)}%</small></button></li>)}</ul>{!categories.length && <div className="small-empty">Нет расходов за выбранный период</div>}
  </section>
}
export function MonthlyComparison({ items, month }: { items: Transaction[]; month: Date }) {
  const series = monthlySeries(items, month), [selected, setSelected] = useState(5)
  const max = Math.max(...series.flatMap(point => [point.income, point.expense]), 1)
  const active = series[selected], previousRows = filterPeriod(items, shiftMonth(active.date, -1), 'month').filter(row => row.type !== 'transfer')
  const comparison = spendingComparison(active.expense, totals(previousRows).expense, previousRows.length > 0)
  return <section className="panel monthly-panel"><div className="panel-heading"><h2>Месяц к месяцу</h2><div className="comparison-legend"><span><i />Доходы</span><span><i />Расходы</span></div></div><div className="monthly-chart" aria-label="Сравнение по месяцам">{series.map((point, index) => <button className={`monthly-column ${index === selected ? 'current' : ''}`} key={point.date.toISOString()} aria-label={`Выбрать ${monthLabel(point.date)}`} aria-pressed={index === selected} onClick={() => setSelected(index)}><span className="bar-pair"><span style={{ height: `${point.income / max * 100}%` }} /><span style={{ height: `${point.expense / max * 100}%` }} /></span><span className="bar-month">{point.label}</span></button>)}</div><div className="month-details" aria-live="polite"><div className="month-detail-title"><strong>{monthLabel(active.date)}</strong><span>{comparison.message} · расходы</span></div><div className="month-detail-values"><span>Доходы<strong className="positive">{money(active.income)}</strong></span><span>Расходы<strong className="negative">{money(active.expense)}</strong></span><span>Разница<strong className={active.net >= 0 ? 'positive' : 'negative'}>{money(active.net, { sign: true })}</strong></span></div></div></section>
}
