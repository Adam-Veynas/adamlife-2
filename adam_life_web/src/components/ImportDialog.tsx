import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, CheckCheck, ChevronLeft, CircleAlert, FileText, FileUp, FolderUp, Info, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { dateLabel, expenseCategories, incomeCategories, money, type Transaction } from '../domain/finance'
import { createImportExample, importOutcome, type ImportRow } from '../domain/import'
import { Modal } from './Dialogs'

export function ImportDialog({ month, existing, onImport, onClose }: { month: Date; existing: Transaction[]; onImport: (items: Transaction[]) => number; onClose: () => void }) {
  const [stage, setStage] = useState<0 | 1 | 2>(0), [bank, setBank] = useState<'kaspi' | 'freedom'>('kaspi')
  const [file, setFile] = useState<File | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<ImportRow[] | null>(null), [inspected, setInspected] = useState<string | null>(null)
  const [result, setResult] = useState<ReturnType<typeof importOutcome> | null>(null)
  const fileInput = useRef<HTMLInputElement>(null), timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  function chooseFile(value?: File) {
    if (!value) return
    if (!value.name.toLowerCase().endsWith('.pdf') || (value.type && value.type !== 'application/pdf')) { setError('Выберите PDF-файл. Его содержимое не будет обрабатываться.'); return }
    if (value.size > 20 * 1024 * 1024) { setError('Размер файла должен быть не больше 20 МБ.'); return }
    setFile(value); setError('')
  }
  function review() {
    setLoading(true)
    // Explicitly a UI-state demonstration, not network/file processing.
    timer.current = window.setTimeout(() => { setRows(current => current ?? createImportExample(bank, month, existing)); setLoading(false); setStage(1) }, 600)
  }
  function update(id: string, change: Partial<ImportRow>) { setRows(current => current!.map(row => row.transaction.id === id ? { ...row, ...change } : row)) }
  function confirm() {
    const outcome = importOutcome(rows ?? [], new Set(existing.map(row => row.id)))
    const actual = outcome.transactions.length ? onImport(outcome.transactions) : 0
    setResult({ ...outcome, accepted: actual, duplicates: outcome.duplicates + outcome.accepted - actual }); setStage(2)
  }
  function returnToReview() {
    setRows(current => current!.map(row => {
      const duplicate = existing.find(item => item.id === row.transaction.id)
      return duplicate ? { ...row, duplicate, choice: row.choice === 'exclude' ? 'exclude' : 'duplicate' } : row
    }))
    setStage(1)
  }
  return <Modal title="Импорт выписки" onClose={onClose} wide><div className="import-steps" aria-label="Этап импорта">{['Загрузка', 'Проверка', 'Результат'].map((label, index) => <span key={label} className={index <= stage ? 'current' : ''} aria-current={index === stage ? 'step' : undefined}><b>{index < stage ? <Check size={12} /> : index + 1}</b>{label}</span>)}</div>
    <div className="demo-callout"><Info size={18} /><span><strong>Пример, не обработка PDF</strong>Файл не читается и никуда не отправляется. Проверка работает с готовыми тестовыми записями.</span></div>
    {stage === 0 && <><div className="auto-detect"><span>Автоопределение банка</span><small>Появится с PDF-парсером</small></div><div className="bank-options" role="group" aria-label="Банк выписки">{(['kaspi', 'freedom'] as const).map(id => <button key={id} disabled={loading} className={bank === id ? 'selected' : ''} aria-pressed={bank === id} onClick={() => { if (bank !== id) setRows(null); setBank(id) }}><span className={`bank-logo ${id}`}>{id === 'kaspi' ? 'K' : 'F'}</span><span>{id === 'kaspi' ? 'Kaspi' : 'Freedom'}<small>Ручной выбор</small></span>{bank === id && <Check size={17} />}</button>)}</div><input className="sr-only" ref={fileInput} type="file" accept="application/pdf,.pdf" aria-label="Выбрать PDF-выписку" onChange={event => chooseFile(event.target.files?.[0])} /><button className="file-drop" disabled={loading} onClick={() => fileInput.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); chooseFile(event.dataTransfer.files[0]) }}><span className="upload-icon">{file ? <FileText size={27} /> : <FolderUp size={28} />}</span><strong>{file?.name ?? 'Выберите PDF-выписку'}</strong><span>{file ? 'Выбран только файл, данные не извлечены' : 'PDF до 20 МБ · можно продолжить без файла'}</span><span className="button secondary"><FileUp size={16} />{file ? 'Выбрать другой' : 'Выбрать файл'}</span></button>{error && <p className="form-error" role="alert">{error}</p>}{loading && <p className="processing-state" role="status"><LoaderCircle className="spin" size={18} />Открываем тестовый пример… Не анализируем файл.</p>}<div className="modal-actions"><button className="button secondary" onClick={onClose}>Закрыть</button><button className="button primary" disabled={loading} onClick={review}>{loading ? 'Подготовка примера…' : 'Проверить пример'}<ArrowRight size={16} /></button></div></>}
    {stage === 1 && rows && <><div className="selected-file"><FileText size={24} /><span><strong>{file?.name ?? `Пример ${bank === 'kaspi' ? 'Kaspi' : 'Freedom'}`}</strong><small>Показаны подготовленные операции, не содержимое PDF</small></span></div><div className="review-counts"><span><strong>{rows.length}</strong>Найдено в примере</span><span><strong>{rows.filter(row => row.duplicate).length}</strong>Дублей</span><span><strong>{rows.filter(row => row.ambiguous).length}</strong>Спорных</span></div><ul className="review-rows">{rows.map(row => <li key={row.transaction.id} className={row.choice === 'exclude' ? 'excluded' : ''}><div className="review-row-title"><span><strong>{row.transaction.comment || row.transaction.category}</strong><small>{dateLabel(row.transaction.date)} · {bank === 'kaspi' ? 'Kaspi' : 'Freedom'}</small></span><strong className={row.transaction.type === 'income' ? 'positive' : 'negative'}>{row.transaction.type === 'income' ? '+' : '−'}{money(row.transaction.amountMinor)}</strong></div>
      {row.duplicate ? <div className="duplicate-review"><button className="text-action" onClick={() => setInspected(inspected === row.transaction.id ? null : row.transaction.id)}><CircleAlert size={15} />Уже есть в истории · проверить</button>{inspected === row.transaction.id && <p>Совпадает устойчивый ID тестовой записи. В истории: {row.duplicate.comment || row.duplicate.category}, {dateLabel(row.duplicate.date)}, {money(row.duplicate.amountMinor)}. Пропустим повтор; одна дата и сумма не являются основанием для дубля.</p>}</div> : <><label className="review-category"><span>Категория</span><select aria-label={`Категория: ${row.transaction.comment}`} value={row.transaction.category} disabled={row.choice === 'exclude'} onChange={event => update(row.transaction.id, { transaction: { ...row.transaction, category: event.target.value } })}>{(row.transaction.type === 'income' ? incomeCategories : expenseCategories).map(category => <option key={category}>{category}</option>)}</select></label>{row.ambiguous && row.choice === 'review' && <div className="ambiguous-row"><span>Уточните категорию и подтвердите</span><button className="button secondary" onClick={() => update(row.transaction.id, { choice: 'include' })}>Проверено</button></div>}</>}
      <div className="review-row-actions"><span>{row.choice === 'duplicate' ? 'Дубль будет пропущен' : row.choice === 'review' ? 'Останется на проверке' : row.choice === 'exclude' ? 'Исключена' : 'Будет добавлена'}</span><button className="text-action" onClick={() => update(row.transaction.id, { choice: row.choice === 'exclude' ? (row.duplicate ? 'duplicate' : row.ambiguous ? 'review' : 'include') : 'exclude' })}>{row.choice === 'exclude' ? <RotateCcw size={14} /> : <X size={14} />}{row.choice === 'exclude' ? 'Вернуть' : 'Исключить'}</button></div></li>)}</ul><div className="modal-actions"><button className="button secondary" onClick={() => setStage(0)}><ChevronLeft size={16} />Назад</button><button className="button primary" onClick={confirm}><CheckCheck size={16} />Подтвердить выбор</button></div></>}
    {stage === 2 && result && <><div className="import-result-icon"><CheckCheck size={30} /></div><h3 className="result-title">Проверка примера завершена</h3><p className="result-note">Принятые тестовые операции добавлены только в этот браузер. Реальная выписка не обрабатывалась.</p><dl className="import-result"><div><dt>Принято</dt><dd>{result.accepted}</dd></div><div><dt>Исключено</dt><dd>{result.excluded}</dd></div><div><dt>Дублей пропущено</dt><dd>{result.duplicates}</dd></div><div><dt>На проверке</dt><dd>{result.review}</dd></div></dl>{result.review > 0 && <p className="field-note">Спорные записи не добавлены. Можно вернуться, уточнить категорию и подтвердить ещё раз; уже принятые записи повторно не добавятся.</p>}<div className="modal-actions"><button className="button secondary" onClick={returnToReview}>К проверке</button><button className="button primary" onClick={onClose}>Готово</button></div></>}
  </Modal>
}
