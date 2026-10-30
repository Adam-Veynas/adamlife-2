import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { monthLabel, shiftMonth, type FinanceFilter, type Period } from '../domain/finance'
import { AccountSelect } from './Dialogs'

export function PeriodPicker({ month, onMonth }: { month: Date; onMonth: (month: Date) => void }) {
  return <div className="month-picker"><button className="icon-button" aria-label="Предыдущий месяц" onClick={() => onMonth(shiftMonth(month, -1))}><ChevronLeft size={17} /></button><span><CalendarDays size={15} />{monthLabel(month)}</span><button className="icon-button" aria-label="Следующий месяц" onClick={() => onMonth(shiftMonth(month, 1))}><ChevronRight size={17} /></button></div>
}
export function FinanceFilters({ filter, onChange }: { filter: FinanceFilter; onChange: (filter: FinanceFilter) => void }) {
  return <div className="period-toolbar">{filter.period !== 'all' ? <PeriodPicker month={filter.month} onMonth={month => onChange({ ...filter, month })} /> : <span className="all-time-label">Вся доступная история</span>}<div className="period-tabs" role="group" aria-label="Период">{([['month', 'Месяц'], ['quarter', '3 месяца'], ['all', 'Всё время']] as [Period, string][]).map(([period, label]) => <button key={period} className={filter.period === period ? 'selected' : ''} aria-pressed={filter.period === period} onClick={() => onChange({ ...filter, period })}>{label}</button>)}</div><AccountSelect label="Счета" all value={filter.account} onChange={account => onChange({ ...filter, account })} /></div>
}
export function periodCaption(filter: FinanceFilter) {
  return filter.period === 'all' ? 'Всё время' : filter.period === 'quarter' ? `${monthLabel(shiftMonth(filter.month, -2))} — ${monthLabel(filter.month)}` : monthLabel(filter.month)
}
