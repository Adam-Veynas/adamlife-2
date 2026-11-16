import type { Account, Currency, Operation } from './client'
import { day, type DepositPeriod } from './depositCalculations'

export function depositTerm(end: string | null | undefined, today: string) {
  if (!end) return null
  const finish = day(end), now = day(today)
  if (finish === null || now === null) return null
  const days = (finish - now) / 86400000
  return { end, days, status: days < 0 ? 'Срок истёк' : days <= 30 ? 'Скоро заканчивается' : 'Активен' }
}

export function depositHistory(account: Account, operations: Operation[], asOf: string, months: DepositPeriod) {
  const stamp = day(asOf)
  if (stamp === null) return null
  const startDate = new Date(stamp)
  startDate.setUTCDate(1)
  startDate.setUTCMonth(startDate.getUTCMonth() - months + 1)
  const start = startDate.toISOString().slice(0, 10)
  const entries = operations.filter(op => op.currency === account.currency && op.occurred_on >= account.opening_date && op.occurred_on <= asOf &&
    (op.account_id === account.id || (op.kind === 'transfer' && op.destination_account_id === account.id)))
    .map(op => ({ op, delta: BigInt(op.amount_minor) * (op.kind === 'expense' || (op.kind === 'transfer' && op.account_id === account.id) ? -1n : 1n) }))
    .sort((a, b) => a.op.occurred_on.localeCompare(b.op.occurred_on))
  let added = 0n, withdrawn = 0n
  for (const { op } of entries) if (op.kind === 'transfer') {
    if (op.destination_account_id === account.id) added += BigInt(op.amount_minor)
    if (op.account_id === account.id) withdrawn += BigInt(op.amount_minor)
  }
  const opening = BigInt(account.opening_balance_minor)
  let balance = account.opening_date < start ? opening : 0n, cursor = 0
  while (cursor < entries.length && entries[cursor].op.occurred_on < start) balance += entries[cursor++].delta
  const baseline = balance
  let openingApplied = account.opening_date < start
  const points: { date: string; label: string; amount: bigint }[] = []
  for (let index = 0; index < months; index++) {
    const end = new Date(startDate)
    end.setUTCMonth(end.getUTCMonth() + index + 1)
    end.setUTCDate(0)
    const cutoff = index === months - 1 ? asOf : end.toISOString().slice(0, 10)
    if (!openingApplied && account.opening_date <= cutoff) { balance += opening; openingApplied = true }
    while (cursor < entries.length && entries[cursor].op.occurred_on <= cutoff) balance += entries[cursor++].delta
    const label = new Intl.DateTimeFormat('ru-RU', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(end)
    if (cutoff >= account.opening_date) points.push({ date: cutoff, label, amount: balance })
  }
  return { start, points, baseline, change: balance - baseline, added, withdrawn }
}

export function compareDeposits(accounts: Account[], operations: Operation[], asOf: string, months: DepositPeriod) {
  const deposits = accounts.filter(a => a.kind === 'deposit')
  if (deposits.length < 2) return []
  // Index once: a transfer is placed in both accounts' histories, not duplicated within either.
  const byId = new Map(deposits.map(a => [a.id, [] as Operation[]]))
  for (const op of operations) {
    byId.get(op.account_id)?.push(op)
    if (op.kind === 'transfer' && op.destination_account_id && op.destination_account_id !== op.account_id) byId.get(op.destination_account_id)?.push(op)
  }
  return (['KZT', 'USD', 'EUR'] as Currency[]).map(currency => ({ currency, rows: deposits.filter(a => a.currency === currency).map(account => ({
    account, history: depositHistory(account, byId.get(account.id)!, asOf, months),
  })) })).filter(group => group.rows.length > 0)
}
