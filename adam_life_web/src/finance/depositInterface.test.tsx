import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountGroups, accountGroups } from './AccountGroups'
import { DepositDetails, depositOperations, depositTransfer } from './DepositDetails'
import { OperationRows, operationDirection } from './OperationRows'
import { AccountEditor, OperationEditor } from './Editors'
import { depositEditorValues, type Account, type Operation, type Snapshot } from './client'

const deposit: Account = { id: 'd', name: 'Резерв', kind: 'deposit', bank_code: 'Мой банк', currency: 'KZT', deposit_type: 'savings', opening_balance_minor: '100000', balance_minor: '120000', opening_date: '2026-10-15', deposit_opened_on: '2026-01-02', annual_rate: '14.2500', archived: false, version: 3 }
const card: Account = { ...deposit, id: 'c', name: 'Карта', kind: 'bank' }
const op: Operation = { id: 't', kind: 'transfer', account_id: 'c', destination_account_id: 'd', currency: 'KZT', amount_minor: '20000', category_id: null, occurred_on: '2026-11-06', comment: '', version: 1 }
const data: Snapshot = { as_of: '2026-11-10', accounts: [deposit, card], operations: [op], categories: [], balances: { KZT: { total_minor: '240000', current_minor: '120000', deposit_minor: '120000' }, USD: { total_minor: '0', current_minor: '0', deposit_minor: '0' }, EUR: { total_minor: '0', current_minor: '0', deposit_minor: '0' } } }
const noop = () => {}

describe('simplified real finance interface', () => {
  it('partitions all accounts once and never mixes currencies', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...deposit, id: `d${i}` }))
    const groups = accountGroups([card, ...many, { ...deposit, id: 'usd', currency: 'USD' }], 'KZT')
    expect(groups.regular).toEqual([card]); expect(groups.deposits).toHaveLength(50)
    expect(new Set([...groups.regular, ...groups.deposits].map(a => a.id)).size).toBe(51)
  })
  it('renders actual deposit bank/type/currency without fixed bank accounts', () => {
    const html = renderToStaticMarkup(<AccountGroups accounts={[deposit]} currency="KZT" onOpen={noop} onAdd={noop} />)
    expect(html).toContain('Мой банк'); expect(html).toContain('Накопительный'); expect(html).toContain('₸')
    expect(html).toContain('Мои счета'); expect(html).toContain('Депозиты'); expect(html).not.toContain('Kaspi')
  })
  it('prefills additions/withdrawals as opposite directions of the same transfer mechanism', () => {
    expect(depositTransfer(data, deposit, 'add')).toEqual({ kind: 'transfer', account_id: 'c', destination_account_id: 'd' })
    expect(depositTransfer(data, deposit, 'withdraw')).toEqual({ kind: 'transfer', account_id: 'd', destination_account_id: 'c' })
  })
  it('rejects archived/same-account/foreign-currency transfer presets', () => {
    expect(depositTransfer(data, { ...deposit, archived: true }, 'add')).toBeNull()
    for (const accounts of [[deposit], [deposit, { ...card, archived: true }], [deposit, { ...card, currency: 'USD' as const }]]) {
      expect(depositTransfer({ ...data, accounts }, deposit, 'withdraw')).toBeNull()
    }
    expect(depositTransfer({ ...data, accounts: [deposit, { ...card, kind: 'deposit' }] }, deposit, 'add')?.account_id).toBe('c')
  })
  it('uses the existing editor with transfer preselected', () => {
    const html = renderToStaticMarkup(<OperationEditor data={data} preset={depositTransfer(data, deposit, 'add')!} onSave={async () => {}} onClose={noop} />)
    expect(html).toContain('class="selected">Перевод'); expect(html).toContain('value="c" selected=""'); expect(html).toContain('value="d" selected=""')
  })
  it('shows every operation once in deposit history, newest first, with correct signs', () => {
    const expense = { ...op, id: 'e', kind: 'expense' as const, account_id: 'd', destination_account_id: null, occurred_on: '2026-11-07' }
    const foreign = { ...expense, id: 'foreign', account_id: 'c' }
    const list = depositOperations({ ...data, operations: [op, foreign, expense] }, deposit)
    expect(list.map(o => o.id)).toEqual(['e', 't'])
    expect(operationDirection(op, data.accounts)).toBe('Карта → Резерв')
    const html = renderToStaticMarkup(<OperationRows items={list} data={data} accountId="d" onSelect={noop} />)
    expect(html).toContain('operation-transfer'); expect(html).toContain('operation-expense'); expect(html).toContain('Карта → Резерв')
    expect(html).toContain('+200'); expect(html).toContain('−200')
  })
  it.each(['overview', 'savings', 'history'] as const)('renders compact %s tab without goals, plans, forecasts or month scrubber', initialTab => {
    const html = renderToStaticMarkup(<DepositDetails account={deposit} data={data} initialTab={initialTab} onTransfer={noop} onOperation={noop} onEdit={noop} />)
    expect((html.match(/role="tab"/g) ?? []).length).toBe(3)
    expect(html).toContain(`aria-labelledby="deposit-tab-${initialTab}"`)
    expect(html).not.toMatch(/Цели накопления|Ежемесячное пополнение|Прогноз доходности|type="range"/)
    if (initialTab === 'history') expect(html).toContain('Карта → Резерв')
    else { expect(html).toContain('Пополнить'); expect(html).toContain('Снять') }
  })
  it('does not send hidden interest or accounting baseline in deposit metadata edits', () => {
    const values = depositEditorValues('deposit', 'savings', deposit.deposit_opened_on!, '2027-01-01')
    expect(values).toEqual({ deposit_type: 'savings', deposit_opened_on: '2026-01-02', deposit_ends_on: '2027-01-01' })
    expect(values).not.toHaveProperty('annual_rate'); expect(values).not.toHaveProperty('opening_balance_minor'); expect(values).not.toHaveProperty('opening_date')
  })
  it('preserves initial balance/date values in editing form and hides accounting fields initially', () => {
    const html = renderToStaticMarkup(<AccountEditor item={deposit} onSave={async () => {}} onClose={noop} />)
    expect(html).toContain('value="1000.00"'); expect(html).toContain('value="2026-10-15"'); expect(html).toContain('Параметры учёта')
    expect(html).not.toContain('<details open'); expect(html).not.toContain('Годовая ставка')
    expect(deposit.annual_rate).toBe('14.2500')
  })
})
