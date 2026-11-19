import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { commitReadyPortion } from './importReview'
import { ImportCategoryRow } from './KaspiImport'

const row = { description: 'Тестовый получатель', signed_minor: '-100', bank_type: 'Покупка' }
const categories = [
  { id: 'expense', kind: 'expense' as const, name: 'Продукты', version: 1, archived: false },
  { id: 'income', kind: 'income' as const, name: 'Зарплата', version: 1, archived: false },
  { id: 'archived', kind: 'expense' as const, name: 'Архив', version: 1, archived: true },
]
const onSave = async () => {}

describe('partial import decisions', () => {
  it('saves only server-ready rows with fresh revision, even with pending rows and a mismatch', async () => {
    const result = { added: 3, remaining: 208, complete: false }
    const request = vi.fn().mockResolvedValueOnce({ new: 3, review: 208, difference_minor: '42', revision: 'fresh' }).mockResolvedValueOnce(result)
    expect(await commitReadyPortion(request, 'draft', { account_id: 'a', revision: 'old' })).toEqual(result)
    expect(request).toHaveBeenNthCalledWith(2, '/draft/commit', 'POST', { account_id: 'a', revision: 'fresh', ready_only: true, use_statement_opening: false })
  })
  it('never commits when all rows are duplicates or still ambiguous', async () => {
    const request = vi.fn().mockResolvedValue({ new: 0, review: 10, revision: 'fresh' })
    await expect(commitReadyPortion(request, 'draft', {})).rejects.toThrow('нет новых готовых')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('does not force or retry an import rejected by the server', async () => {
    const request = vi.fn().mockResolvedValueOnce({ new: 1, revision: 'fresh' }).mockRejectedValueOnce(new Error('Данные изменились'))
    await expect(commitReadyPortion(request, 'draft', {})).rejects.toThrow('Данные изменились')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('never rebases the account as a side effect of saving a portion', async () => {
    const request = vi.fn().mockResolvedValueOnce({ new: 1, revision: 'fresh' }).mockResolvedValueOnce({ added: 1 })
    await commitReadyPortion(request, 'draft', { use_statement_opening: true })
    expect(request.mock.calls[0][2].use_statement_opening).toBe(false)
    expect(request.mock.calls[1][2].use_statement_opening).toBe(false)
  })
  it('shows only applicable active categories and a new-category action, without re-entering PDF fields', () => {
    const html = renderToStaticMarkup(<ImportCategoryRow row={row} categories={categories} disabled={false} onSave={onSave} />)
    expect(html).toContain(row.description); expect(html).toContain('Продукты'); expect(html).toContain('Новая категория'); expect(html).toContain('Сохранить')
    expect(html).not.toContain('Зарплата'); expect(html).not.toContain('Архив'); expect(html).not.toContain('type="date"'); expect(html).not.toContain('type="number"')
  })
  it('lets a person transfer use a category just now, without default future consent', () => {
    const html = renderToStaticMarkup(<ImportCategoryRow row={{ ...row, bank_type: 'Перевод' }} categories={categories} disabled={false} onSave={onSave} />)
    expect(html).toContain('Запомнить для будущих'); expect(html).not.toContain('checked=""')
  })
})
