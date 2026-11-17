import { afterEach, describe, expect, it, vi } from 'vitest'
import { bulkReview, canBulkReview, filterImportRows, uploadPDF, type ReviewableRow } from './importReview'
const row: ReviewableRow = { index: 0, signed_minor: '-100', kind: 'expense', status: 'review', own_hint: false, candidates: [] }
afterEach(() => vi.unstubAllGlobals())
describe('import review and upload fixes', () => {
  it('confirms a selected ordinary batch without changing unselected rows', () => {
    const rows = Array.from({ length: 211 }, (_, index) => ({ ...row, index }))
    const category = { id: 'food', name: 'Продукты', kind: 'expense' as const, archived: false, version: 1 }
    const choices = bulkReview(rows, [0, 2, 210], {}, category, true)
    expect(Object.keys(choices)).toHaveLength(3)
    expect(choices[2]).toMatchObject({ reviewed: true, category_id: 'food', remember_category: true })
    expect(choices[1]).toBeUndefined()
  })
  it.each([{ kind: 'adjustment' }, { own_hint: true }, { candidates: [{}] }, { status: 'duplicate' }, { status: 'before_opening' }])('does not mass-confirm an ambiguous row %s', patch => {
    const value = { ...row, ...patch }
    expect(canBulkReview(value)).toBe(false)
    expect(() => bulkReview([value], [0], {})).toThrow()
  })
  it('rejects mixed-sign category assignment atomically', () => {
    const current = { 0: { index: 0, reviewed: false } }
    expect(() => bulkReview([row, { ...row, index: 1, signed_minor: '100', kind: 'income' }], [0, 1], current,
      { id: 'food', name: 'Продукты', kind: 'expense', archived: false, version: 1 })).toThrow()
    expect(current[0].reviewed).toBe(false)
  })
  it('filters all statuses without dropping skipped rows from All', () => {
    const rows = ['new', 'review', 'before_opening', 'duplicate', 'skip'].map((status, index) => ({ ...row, status, index }))
    expect(filterImportRows(rows, 'all')).toHaveLength(5)
    expect(filterImportRows(rows, 'defined')).toHaveLength(1)
    expect(filterImportRows(rows, 'review')).toHaveLength(2)
    expect(filterImportRows(rows, 'duplicates')).toHaveLength(1)
  })
  it('uploads the exact same buffered bytes repeatedly regardless of MIME', async () => {
    const fetch = vi.fn(async () => new Response('{"id":"draft"}', { status: 201 })); vi.stubGlobal('fetch', fetch)
    for (const type of ['', 'application/octet-stream', 'application/pdf']) {
      const file = new Blob(['%PDF-synthetic'], { type })
      await uploadPDF(file, 'csrf'); await uploadPDF(file, 'csrf')
    }
    expect(fetch).toHaveBeenCalledTimes(6)
    for (const call of fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(new TextDecoder().decode(call[1].body as ArrayBuffer)).toBe('%PDF-synthetic')
      expect(call[1].credentials).toBe('include')
    }
  })
  it('distinguishes invalid bytes, incomplete reads, network and server failures', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(uploadPDF(new Blob(['not PDF'], { type: 'application/pdf' }), '')).rejects.toThrow('не является PDF')
    await expect(uploadPDF(new Blob([]), '')).rejects.toThrow('не полностью')
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRejectedValueOnce(new TypeError('offline'))
    await expect(uploadPDF(new Blob(['%PDF-test']), '')).rejects.toThrow('Нет ответа сервера')
    fetch.mockResolvedValueOnce(new Response('<html>unavailable</html>', { status: 503 }))
    await expect(uploadPDF(new Blob(['%PDF-test']), '')).rejects.toThrow('Сервер')
  })
})
