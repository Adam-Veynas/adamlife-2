import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Check, HardDrive, Info, Pencil, ShieldCheck, Trash2, X } from 'lucide-react'
import { accountLabel, accountNames, accountOf, amountInput, dateLabel, expenseCategories, incomeCategories, localDate, money, newId, type AccountId, type Transaction, type TransactionType } from '../domain/finance'
import { transactionFromDraft } from '../domain/mutations'
import { CategoryIcon } from './TransactionList'

export function Modal({ title, description, onClose, children, wide = false }: { title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = ref.current!
    element.showModal()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const viewport = window.visualViewport
    const resize = () => { element.style.setProperty('--viewport-height', `${viewport?.height ?? window.innerHeight}px`); element.style.setProperty('--viewport-top', `${viewport?.offsetTop ?? 0}px`) }
    resize(); viewport?.addEventListener('resize', resize); viewport?.addEventListener('scroll', resize)
    return () => { document.body.style.overflow = previous; viewport?.removeEventListener('resize', resize); viewport?.removeEventListener('scroll', resize); element.close() }
  }, [])
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-labelledby="modal-title" aria-describedby={description ? 'modal-description' : undefined} onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose() } }}><div className="modal-inner"><div className="modal-header"><div><h2 id="modal-title">{title}</h2>{description && <p id="modal-description">{description}</p>}</div><button className="icon-button modal-close" aria-label="Закрыть окно" onClick={onClose}><X size={20} /></button></div>{children}</div></dialog>
}
export function AccountSelect({ value, onChange, label = 'Счёт', all = false }: { value: AccountId | 'all'; onChange: (value: AccountId | 'all') => void; label?: string; all?: boolean }) {
  return <label className="field account-select"><span>{label}</span><select aria-label={label} value={value} onChange={event => onChange(event.target.value as AccountId | 'all')}>{all && <option value="all">Все счета</option>}{Object.entries(accountNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
}
export function TransactionEditor({ item, initialType = 'expense', onSave, onClose }: { item?: Transaction; initialType?: TransactionType; onSave: (item: Transaction) => void; onClose: () => void }) {
  const [type, setType] = useState(item?.type ?? initialType)
  const [amount, setAmount] = useState(item ? amountInput(item.amountMinor) : '')
  const [category, setCategory] = useState(item?.category ?? (initialType === 'income' ? 'Зарплата' : 'Продукты'))
  const [date, setDate] = useState(item?.date ?? localDate(new Date()))
  const [account, setAccount] = useState<AccountId>(item ? accountOf(item) : 'kaspi')
  const [destination, setDestination] = useState<AccountId>(item?.toAccountId ?? 'cash')
  const [comment, setComment] = useState(item?.comment ?? '')
  const [error, setError] = useState('')
  const categories = type === 'expense' ? expenseCategories : incomeCategories
  function submit(event: FormEvent) {
    event.preventDefault()
    try { onSave(transactionFromDraft({ id: item?.id ?? newId(), type, amount, date, category, accountId: account, toAccountId: destination, comment, source: item?.source ?? 'manual' })) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Проверьте данные операции.'); return }
    onClose()
  }
  return <Modal title={item ? 'Редактировать операцию' : 'Новая операция'} onClose={onClose}><form className="transaction-form" onSubmit={submit}>
    <div className="type-toggle" role="group" aria-label="Тип операции">{([['expense', 'Расход', ArrowUpRight], ['income', 'Доход', ArrowDownLeft], ['transfer', 'Перевод', ArrowLeftRight]] as const).map(([value, label, Icon]) => <button key={value} type="button" className={type === value ? 'selected' : ''} aria-pressed={type === value} onClick={() => { setType(value); setCategory(value === 'income' ? incomeCategories[0] : expenseCategories[0]); setError('') }}><Icon size={16} />{label}</button>)}</div>
    <label className="amount-field"><span>Сумма</span><span className="amount-input-wrap"><input inputMode="decimal" aria-invalid={!!error} aria-describedby={error ? 'form-error' : undefined} placeholder="0" value={amount} onChange={event => { setAmount(event.target.value); setError('') }} maxLength={18} required /><span>₸</span></span></label>
    <div className="form-grid"><AccountSelect label={type === 'transfer' ? 'Со счёта' : 'Счёт'} value={account} onChange={value => setAccount(value as AccountId)} />{type === 'transfer' ? <AccountSelect label="На счёт" value={destination} onChange={value => setDestination(value as AccountId)} /> : <label className="field"><span>Категория</span><select value={category} onChange={event => setCategory(event.target.value)}>{!categories.includes(category) && <option>{category}</option>}{categories.map(value => <option key={value}>{value}</option>)}</select></label>}</div>
    <label className="field"><span>Дата операции</span><input type="date" min="1900-01-01" max="2100-12-31" required value={date} onChange={event => setDate(event.target.value)} /></label>
    <label className="field"><span>Комментарий <small>необязательно</small></span><textarea placeholder={type === 'transfer' ? 'Например, снятие наличных' : 'Например, покупки на неделю'} value={comment} onChange={event => setComment(event.target.value)} maxLength={300} rows={2} /></label>
    {error && <div id="form-error" className="form-error" role="alert">{error}</div>}
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Отмена</button><button className="button primary" type="submit"><Check size={16} />{item ? 'Сохранить' : 'Добавить'}</button></div>
  </form></Modal>
}
export function TransactionDetail({ item, onClose, onEdit, onDelete }: { item: Transaction; onClose: () => void; onEdit: () => void; onDelete: () => void }) {
  return <Modal title="Детали операции" onClose={onClose}><div className="detail-hero"><CategoryIcon category={item.category} income={item.type === 'income'} /><strong className={item.type === 'income' ? 'positive' : item.type === 'expense' ? 'negative' : ''}>{item.type === 'income' ? '+' : item.type === 'expense' ? '−' : ''}{money(item.amountMinor)}</strong><span>{item.type === 'income' ? 'Доход' : item.type === 'expense' ? 'Расход' : 'Перевод между своими счетами'}</span></div><dl className="detail-list"><div><dt>Категория</dt><dd>{item.category}</dd></div><div><dt>Счёт</dt><dd>{accountLabel(item)}</dd></div><div><dt>Дата</dt><dd>{dateLabel(item.date)} {item.date.slice(0, 4)}</dd></div><div><dt>Комментарий</dt><dd>{item.comment || 'Не указан'}</dd></div></dl><div className="modal-actions"><button className="button danger-text" onClick={onDelete}><Trash2 size={16} />Удалить</button><button className="button primary" onClick={onEdit}><Pencil size={15} />Редактировать</button></div></Modal>
}
export function DeleteConfirmation({ item, onClose, onConfirm }: { item: Transaction; onClose: () => void; onConfirm: () => void }) {
  return <Modal title="Удалить операцию?" description="Отменить это действие нельзя." onClose={onClose}><p className="delete-summary">{item.comment || item.category} · {money(item.amountMinor)}</p><div className="modal-actions"><button className="button secondary" onClick={onClose}>Отмена</button><button className="button danger" onClick={() => { onConfirm(); onClose() }}>Удалить</button></div></Modal>
}
export function InfoDialog({ onClose }: { onClose: () => void }) {
  return <Modal title="Тестовое пространство" onClose={onClose}><div className="info-points"><div><Info size={20} /><span><strong>Суммы вымышлены</strong>Данные предназначены для оценки интерфейса, а не для ведения реальных финансов.</span></div><div><HardDrive size={20} /><span><strong>Сохранение в этом браузере</strong>Очистка данных сайта удалит записи. Устройства и разные адреса сайта не синхронизируются.</span></div><div><ShieldCheck size={20} /><span><strong>Без подключения к банкам</strong>Нет сервера и отправки файлов. Импорт работает только с заранее подготовленным примером. Уведомления не отправляются.</span></div></div><div className="modal-actions"><button className="button primary" onClick={onClose}>Понятно</button></div></Modal>
}
