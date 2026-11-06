import { useState } from 'react'
import { depositDetails, formatMoney, type Snapshot } from './client'
import { DepositHistoryPanel } from './DepositHistoryViews'
import { DEPOSIT_INTEREST_CATEGORY, depositForecast, depositMovements, type DepositPeriod } from './depositCalculations'

export function DepositInsights({ accountId, data }: { accountId: string; data: Snapshot }) {
  const [months, setMonths] = useState<DepositPeriod>(3)
  const account = data.accounts.find(a => a.id === accountId)
  if (!account || account.kind !== 'deposit') return null
  const forecast = depositForecast(account, data.as_of, months)
  const movements = depositMovements(account, data.operations, data.categories, data.as_of)
  const dateLabel = (value: string) => value.split('-').reverse().join('.')
  const money = (value: bigint) => formatMoney(value, account.currency)
  const rows: [string, bigint][] = [['Начальный баланс', movements.opening], ['Пополнено переводами', movements.added], ['Снято переводами', movements.withdrawn], ['Полученные проценты', movements.interest], ['Текущий остаток', movements.current]]
  return <div className="deposit-insights">
    <DepositHistoryPanel account={account} data={data} />
    <details className="deposit-extra"><summary>Ставка и прогноз · дополнительно</summary><section aria-labelledby="deposit-forecast-title"><h3 id="deposit-forecast-title">Прогноз доходности</h3><p className="ledger-hint">Годовая ставка: {depositDetails(account).find(([label]) => label === 'Годовая ставка')?.[1]}</p>
      <p className="ledger-hint">От текущего остатка на {dateLabel(data.as_of)}.</p>
      {account.deposit_type === 'savings' && !account.deposit_ends_on && <label className="field deposit-period"><span>Период прогноза</span><select value={months} onChange={e => setMonths(Number(e.target.value) as DepositPeriod)}><option value={3}>3 месяца</option><option value={6}>6 месяцев</option><option value={12}>12 месяцев</option></select></label>}
      <div aria-live="polite">{forecast.available ? <>
        {forecast.ended && <p className="ledger-hint">Срок депозита завершён. Будущий доход не начисляется в прогнозе.</p>}
        <dl className="detail-list"><div><dt>До {dateLabel(forecast.end)}</dt><dd>{forecast.days} дн.</dd></div><div><dt>Ориентировочный доход</dt><dd>{money(forecast.income)}</dd></div><div><dt>{forecast.ended ? 'Сумма без будущих процентов' : account.deposit_ends_on ? 'Прогноз к дате окончания' : 'Прогноз к концу периода'}</dt><dd>{money(forecast.total)}</dd></div></dl>
      </> : <p className="ledger-hint">{forecast.message}</p>}</div>
      <p className="ledger-hint">Приблизительно: остаток × ставка × дни / 365. Без капитализации и будущих пополнений или снятий. Фактические условия зависят от банка. Прогноз не меняет баланс.</p>
    </section></details>
    <section aria-labelledby="deposit-movements-title"><h3 id="deposit-movements-title">Движение денег</h3><p className="ledger-hint">С начала учёта по {dateLabel(data.as_of)}.</p>
      <dl className="detail-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{money(value)}</dd></div>)}</dl>
      <p className="ledger-hint">Проценты — только доходы с категорией «{DEPOSIT_INTEREST_CATEGORY}», включая архивную. Переименование или смена категории изменяет этот итог. Остаток также учитывает остальные доходы и расходы счёта.</p>
    </section>
  </div>
}
