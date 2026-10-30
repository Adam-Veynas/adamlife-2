import { useEffect, useRef, useState } from 'react'
import { Check, FileUp, Plus, X } from 'lucide-react'
import { Layout, navigation } from './components/Layout'
import { DeleteConfirmation, InfoDialog, TransactionDetail, TransactionEditor } from './components/Dialogs'
import { ImportDialog } from './components/ImportDialog'
import { Analytics, Home, Operations } from './components/Pages'
import { MarkPaymentPaid, PaymentDetail, PaymentEditor, Payments } from './components/Payments'
import { monthLabel, type FinanceFilter, type OperationFilter, type Transaction, type TransactionType, type View } from './domain/finance'
import type { Payment, PaymentOccurrence } from './domain/payments'
import { useFinance } from './hooks/useFinance'

type DialogState = { kind: 'new'; type: TransactionType } | { kind: 'detail'; item: Transaction } | { kind: 'edit'; item: Transaction } | { kind: 'delete'; item: Transaction } | { kind: 'payment-new' } | { kind: 'payment-edit'; payment: Payment } | { kind: 'payment-detail'; row: PaymentOccurrence } | { kind: 'payment-paid'; row: PaymentOccurrence } | { kind: 'import' | 'info' } | null

export function App() {
  const finance = useFinance()
  const [view, setView] = useState<View>('overview')
  const [filter, setFilter] = useState<OperationFilter>({ month: new Date(new Date().getFullYear(), new Date().getMonth(), 1), period: 'month', account: 'all', query: '', kind: 'all', category: '', sort: 'date-desc' })
  const [dialog, setDialog] = useState<DialogState>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const baseFilter: FinanceFilter = { month: filter.month, period: filter.period, account: filter.account }
  const title = navigation.find(item => item.id === view)!.title
  useEffect(() => { if (!finance.notice) return; const timer = window.setTimeout(finance.dismissNotice, 7000); return () => window.clearTimeout(timer) }, [finance.notice])
  useEffect(() => { document.title = `AdamLife — ${title}` }, [title])
  function navigate(next: View) { setView(next); window.scrollTo({ top: 0, behavior: 'instant' }); document.querySelector('main')?.scrollTo({ top: 0, behavior: 'instant' }); mainRef.current?.focus({ preventScroll: true }) }
  function openCategory(category: string) { setFilter({ ...filter, query: '', category, kind: 'expense', sort: 'date-desc' }); navigate('transactions') }
  const close = () => setDialog(null), add = () => setDialog({ kind: 'new', type: 'expense' })
  const onOpen = (item: Transaction) => setDialog({ kind: 'detail', item })
  const onImport = () => setDialog({ kind: 'import' })
  return <Layout view={view} onNavigate={navigate} onAdd={add} onInfo={() => setDialog({ kind: 'info' })}>
    <div ref={mainRef} tabIndex={-1} className="page-content"><header className="page-header"><div><h1>{title}</h1>{view === 'overview' && <p>{monthLabel(new Date())}</p>}</div><div className="page-actions">{view === 'transactions' && <button className="button secondary" onClick={onImport}><FileUp size={16} />Импорт PDF</button>}<button className="button primary desktop-add" onClick={add}><Plus size={17} />Добавить операцию</button></div></header>
      {view === 'overview' && <Home data={finance.data} onAdd={add} onImport={onImport} onOpen={onOpen} onOperations={() => { setFilter({ ...filter, kind: 'all', query: '', category: '', period: 'all', account: 'all' }); navigate('transactions') }} onPayments={() => navigate('payments')} onPayment={row => setDialog({ kind: 'payment-detail', row })} />}
      {view === 'transactions' && <Operations items={finance.data.transactions} filter={filter} onFilter={setFilter} onAdd={add} onImport={onImport} onOpen={onOpen} />}
      {view === 'analytics' && <Analytics items={finance.data.transactions} filter={baseFilter} onFilter={next => setFilter({ ...filter, ...next })} onCategory={openCategory} />}
      {view === 'payments' && <Payments payments={finance.data.payments ?? []} onOpen={row => setDialog({ kind: 'payment-detail', row })} onAdd={() => setDialog({ kind: 'payment-new' })} />}
    </div>
    {finance.notice && <div className="toast" role="status"><span><Check size={16} /></span><p>{finance.notice}</p><button aria-label="Закрыть сообщение" onClick={finance.dismissNotice}><X size={16} /></button></div>}
    {(dialog?.kind === 'new' || dialog?.kind === 'edit') && <TransactionEditor key={dialog.kind === 'edit' ? dialog.item.id : `new-${dialog.type}`} item={dialog.kind === 'edit' ? dialog.item : undefined} initialType={dialog.kind === 'new' ? dialog.type : undefined} onSave={finance.saveTransaction} onClose={close} />}
    {dialog?.kind === 'detail' && <TransactionDetail item={dialog.item} onClose={close} onEdit={() => setDialog({ kind: 'edit', item: dialog.item })} onDelete={() => setDialog({ kind: 'delete', item: dialog.item })} />}
    {dialog?.kind === 'delete' && <DeleteConfirmation item={dialog.item} onClose={close} onConfirm={() => finance.deleteTransaction(dialog.item.id)} />}
    {dialog?.kind === 'import' && <ImportDialog month={filter.month} existing={finance.data.transactions} onImport={finance.importDemo} onClose={close} />}
    {dialog?.kind === 'info' && <InfoDialog onClose={close} />}
    {(dialog?.kind === 'payment-new' || dialog?.kind === 'payment-edit') && <PaymentEditor payment={dialog.kind === 'payment-edit' ? dialog.payment : undefined} onSave={finance.savePayment} onClose={close} />}
    {dialog?.kind === 'payment-detail' && <PaymentDetail row={dialog.row} transactions={finance.data.transactions} onClose={close} onEdit={() => setDialog({ kind: 'payment-edit', payment: dialog.row.payment })} onPaid={() => setDialog({ kind: 'payment-paid', row: dialog.row })} />}
    {dialog?.kind === 'payment-paid' && <MarkPaymentPaid row={dialog.row} transactions={finance.data.transactions} onClose={close} onSave={(date, id) => finance.markPaid(dialog.row, date, id)} />}
  </Layout>
}
