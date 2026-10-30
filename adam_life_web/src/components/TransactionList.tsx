import { ArrowLeftRight, ArrowRight, BriefcaseBusiness, CarFront, CircleEllipsis, CreditCard, HeartPulse, House, Search, ShoppingBag, ShoppingBasket, Sparkles, Ticket, Wallet, X, type LucideIcon } from 'lucide-react'
import { accountLabel, dateLabel, money, type Transaction } from '../domain/finance'

const categoryIcons: Record<string, LucideIcon> = { Продукты: ShoppingBasket, Жильё: House, Транспорт: CarFront, Развлечения: Ticket, Кредиты: CreditCard, Покупки: ShoppingBag, Здоровье: HeartPulse, Другое: CircleEllipsis, Зарплата: BriefcaseBusiness, Бонус: Sparkles, Подработка: Wallet, Перевод: ArrowLeftRight }
export function CategoryIcon({ category, income = false }: { category: string; income?: boolean }) {
  const Icon = categoryIcons[category] ?? CircleEllipsis
  return <span className={`category-icon ${income ? 'income-icon' : ''} ${category === 'Перевод' ? 'transfer-icon' : ''}`}><Icon size={19} strokeWidth={1.6} /></span>
}
export function TransactionList({ items, onOpen, onSeeAll, all = false, onAdd, grouped = false }: { items: Transaction[]; onOpen: (item: Transaction) => void; onSeeAll?: () => void; all?: boolean; onAdd: () => void; grouped?: boolean }) {
  return <section className={`transaction-section panel ${all ? 'full-transactions' : ''}`} aria-label="Список операций">
    {!all && <div className="panel-heading"><h2>Последние операции</h2><button className="text-action" onClick={onSeeAll}>Все <ArrowRight size={15} /></button></div>}
    {items.length ? <ul className="transaction-list">{items.map((item, index) => <li key={item.id} className="operation-entry">
      {grouped && (index === 0 || items[index - 1].date !== item.date) && <h3 className="date-group">{new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${item.date}T12:00:00`))}</h3>}
      <button className="transaction-row" onClick={() => onOpen(item)} aria-label={`${item.comment || item.category}, ${money(item.amountMinor)}, ${item.type === 'income' ? 'доход' : item.type === 'transfer' ? 'перевод' : 'расход'}, открыть`}><span className="transaction-name"><CategoryIcon category={item.type === 'transfer' ? 'Перевод' : item.category} income={item.type === 'income'} /><span><strong>{item.comment || item.category}</strong><small>{item.category} · {accountLabel(item)}{!grouped && ` · ${dateLabel(item.date)}`}</small></span></span><span className={`transaction-amount ${item.type === 'income' ? 'positive' : item.type === 'expense' ? 'negative' : 'neutral'}`}>{item.type === 'income' ? '+' : item.type === 'expense' ? '−' : ''}{money(item.amountMinor)}{item.type === 'transfer' && <ArrowLeftRight size={13} />}</span></button>
    </li>)}</ul> : <div className="empty-state"><Search size={28} /><h3>Операций нет</h3><p>Измените фильтры или добавьте запись.</p><button className="button secondary" onClick={onAdd}>Добавить операцию</button></div>}
  </section>
}
export function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <div className="search-field"><Search size={17} /><input aria-label="Поиск операций" placeholder="Найти операцию…" value={value} onChange={event => onChange(event.target.value)} />{value && <button className="icon-button small" onClick={() => onChange('')} aria-label="Очистить поиск"><X size={14} /></button>}</div>
}
