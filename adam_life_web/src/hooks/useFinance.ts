import { useState } from 'react'
import { prototypeRepository } from '../data/prototypeRepository'
import type { PrototypeData, Transaction } from '../domain/finance'
import type { Payment, PaymentOccurrence } from '../domain/payments'
import * as mutations from '../domain/mutations'

export function useFinance() {
  const [initial] = useState(() => prototypeRepository.load())
  const [data, setData] = useState(initial.data)
  const [notice, setNotice] = useState(initial.warning ?? '')

  function commit(next: PrototypeData, message: string) {
    const saved = prototypeRepository.save(next)
    setData(next)
    setNotice(saved ? message : 'Изменения видны в этой сессии, но браузер не разрешил их сохранить. Не закрывайте страницу.')
  }
  function change(mutate: () => PrototypeData, message: string) {
    try { commit(mutate(), message) } catch (error) { setNotice(error instanceof Error ? error.message : 'Не удалось изменить запись.') }
  }

  return {
    data, notice, dismissNotice: () => setNotice(''), notify: setNotice,
    saveTransaction(item: Transaction) {
      const exists = data.transactions.some(row => row.id === item.id)
      change(() => mutations.saveTransaction(data, item), exists ? 'Изменения сохранены в этом браузере' : 'Операция добавлена')
    },
    deleteTransaction(id: string) {
      change(() => mutations.deleteTransaction(data, id), 'Операция удалена')
    },
    savePayment(payment: Payment) {
      change(() => mutations.savePayment(data, payment), 'Платёж сохранён в этом браузере')
    },
    markPaid(occurrence: PaymentOccurrence, date: string, transactionId?: string) {
      change(() => mutations.markPaymentPaid(data, occurrence, date, transactionId), 'Оплата отмечена. Новая расходная операция не создавалась.')
    },
    importDemo(items: Transaction[]) {
      const ids = new Set(data.transactions.map(row => row.id))
      const fresh = items.filter(row => !ids.has(row.id))
      if (!fresh.length) { setNotice('Эти демонстрационные операции уже добавлены'); return 0 }
      commit({ ...data, transactions: [...data.transactions, ...fresh] }, `Добавлено демонстрационных операций: ${fresh.length}`)
      return fresh.length
    },
  }
}
