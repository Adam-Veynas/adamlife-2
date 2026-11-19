"""Partial Kaspi import: real ledger/RLS, no production data."""
import asyncio
import json
import os
from pathlib import Path
from uuid import UUID

import pytest
from sqlalchemy import select

from app.auth import csrf_token
from app.db import user_session
from app.kaspi_pdf import parse_pdf
from app.models import ImportBatch, ImportMovement
from test_kaspi_postgres import batch, statement, review, commit
from test_finance_postgres import clients, pg_engine, runtime_engine, ORIGIN

pytestmark = pytest.mark.postgres


def category(c, kind='expense'):
    return next(x for x in c.snapshot()['categories'] if x['kind'] == kind)


def assign(c, identifier, account, index, cat, choices=None, remember=True):
    response = c.request('POST', f'/imports/{identifier}/category', dict(account_id=account['id'],
        index=index, category_id=cat['id'], choices=choices or [], ready_only=True, remember=remember))
    assert response.status_code == 200, response.text
    return response.json()


def test_partial_save_keeps_unknown_rows_and_opening_untouched(clients, runtime_engine):
    c = clients(); a = c.account(opening='90000')
    original, _ = c.operation(a, amount='321', occurred_on='2026-01-06')
    identifier = batch(c, runtime_engine, statement((-1000, -200), ['Гелиос', 'Неизвестный продавец']))
    result, body, preview = commit(c, identifier, a, ready_only=True)
    assert preview['new'] == 1 and preview['needs_category'] == 1
    assert result['added'] == 1 and result['remaining'] == 1 and result['preliminary']
    snap = c.snapshot()
    assert snap['accounts'][0]['opening_balance_minor'] == '90000'
    assert snap['accounts'][0]['opening_date'] == a['opening_date']
    assert next(o for o in snap['operations'] if o['id'] == original['id']) == original
    assert snap['accounts'][0]['balance_minor'] == '88679'
    # Retrying the same request after a lost response never saves a second portion.
    retry = c.request('POST', f'/imports/{identifier}/commit', {**body, 'revision': preview['revision']})
    assert retry.status_code == 200 and retry.json() == result
    with user_session(runtime_engine, c.uid) as session:
        assert session.get(ImportBatch, UUID(identifier)).status == 'draft'
        assert len(session.get(ImportBatch, UUID(identifier)).payload['rows']) == 2
    saved = assign(c, identifier, a, 1, category(c))
    assert saved['review']['new'] == 1 and saved['review']['duplicates'] == 1
    rest, _, _ = commit(c, identifier, a, saved['choices'], ready_only=True)
    assert rest['added'] == 1 and rest['complete']
    assert c.snapshot()['accounts'][0]['balance_minor'] == '88479'
    again, _ = review(c, batch(c, runtime_engine, statement((-1000, -200), ['Гелиос', 'Неизвестный продавец'])), a, ready_only=True)
    assert again['duplicates'] == 2 and again['new'] == 0


def test_category_assignment_propagates_without_overwriting_manual_choices(clients, runtime_engine):
    c = clients(); a = c.account(); cats = [x for x in c.snapshot()['categories'] if x['kind'] == 'expense']
    identifier = batch(c, runtime_engine, statement((-100, -200, -300, -400), ['Магазин X', ' Магазин X ', 'Магазин X', 'Магазин XYZ']))
    manual = dict(index=2, category_id=cats[1]['id'])
    result = assign(c, identifier, a, 0, cats[0], [manual])
    rows = result['review']['rows']
    assert [r['category_id'] for r in rows[:3]] == [cats[0]['id'], cats[0]['id'], cats[1]['id']]
    assert result['review']['new'] == 3 and result['review']['needs_category'] == 1
    assert c.snapshot()['operations'] == []  # Saving a category is not an import.
    next_preview, _ = review(c, batch(c, runtime_engine, statement((-900,), ['Магазин X'])), a, ready_only=True)
    assert next_preview['new'] == 1 and next_preview['rows'][0]['category_id'] == cats[0]['id']
    rules = c.request('GET', '/imports/rules').json()
    assert len(rules) == 1
    assert c.request('PUT', '/imports/rules/' + rules[0]['id'], dict(expected_version=rules[0]['version'], category_id=cats[1]['id'])).status_code == 200
    changed = c.request('GET', '/imports/rules').json()[0]
    assert c.request('DELETE', '/imports/rules/' + changed['id'], dict(expected_version=changed['version'])).status_code == 200


def test_recipient_category_can_be_used_only_now(clients, runtime_engine):
    c = clients(); a = c.account()
    identifier = batch(c, runtime_engine, statement((-100, -200), ['Другой человек', 'Другой человек']))
    result = assign(c, identifier, a, 0, category(c), remember=False)
    assert result['review']['new'] == 2
    commit(c, identifier, a, result['choices'], ready_only=True)
    assert c.request('GET', '/imports/rules').json() == []


def test_equal_purchases_keep_multiplicity_while_overlap_stays_ambiguous(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000')
    value = statement((-1000, -1000), ['Гелиос', 'Гелиос'])
    identifier = batch(c, runtime_engine, value)
    saved, _, preview = commit(c, identifier, a, ready_only=True)
    assert preview['new'] == 2 and saved['added'] == 2
    repeated, _ = review(c, batch(c, runtime_engine, value), a, ready_only=True)
    assert repeated['duplicates'] == 2 and repeated['new'] == 0
    overlapping, _ = review(c, batch(c, runtime_engine, statement((-1000, -1000, -1000), ['Гелиос'] * 3)), a, ready_only=True)
    assert overlapping['duplicates'] == 2 and overlapping['financial_review'] == 1
    assert len(c.snapshot()['operations']) == 2


def test_category_never_confirms_ownership_matches_or_refunds(clients, runtime_engine):
    c = clients(); a = c.account()
    c.operation(a, amount='200', occurred_on='2026-01-05')
    value = statement((-100, -200, 300, -400), ['Freedom Finance Bank *1234', 'Магазин X', 'Возврат покупки', 'Tele2'])
    identifier = batch(c, runtime_engine, value)
    decision = assign(c, identifier, a, 0, category(c))
    decision = assign(c, identifier, a, 1, category(c), decision['choices'])
    rows = decision['review']['rows']
    assert 'ownership' in rows[0]['review_reasons']
    assert 'match' in rows[1]['review_reasons']
    assert 'adjustment' in rows[2]['review_reasons']
    saved, _, _ = commit(c, identifier, a, decision['choices'], ready_only=True)
    assert saved['added'] == 1 and saved['remaining'] == 3
    assert all(not o['adjustment_type'] for o in c.snapshot()['operations'])


def test_opening_date_does_not_change_categories_or_block_later_rows(clients, runtime_engine):
    c = clients()
    a = c.request('POST', '/accounts', dict(name='Later baseline', kind='bank', currency='KZT', opening_date='2026-01-06', opening_balance_minor='12345')).json()
    value = statement((-100, -200), ['Гелиос', 'Tele2']); value['rows'][1]['date'] = '2026-01-07'
    identifier = batch(c, runtime_engine, value)
    saved, _, preview = commit(c, identifier, a, ready_only=True)
    assert preview['rows'][0]['category_name'] == 'Топливо'
    assert preview['rows'][0]['status'] == 'before_opening'
    assert saved['added'] == 1 and saved['remaining'] == 1
    account = c.snapshot()['accounts'][0]
    assert account['opening_balance_minor'] == '12345' and account['opening_date'] == '2026-01-06'
    assert account['balance_minor'] == '12145'
    updated, body = review(c, identifier, a, ready_only=True, use_statement_opening=True)
    assert c.request('POST', f'/imports/{identifier}/commit', {**body, 'revision': updated['revision']}).status_code == 422


def test_partial_undo_keeps_existing_and_pending_records(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000')
    original, _ = c.operation(a, amount='100', occurred_on='2026-01-09')
    identifier = batch(c, runtime_engine, statement((-1000, -200), ['Гелиос', 'Магазин X']))
    saved, _, _ = commit(c, identifier, a, ready_only=True)
    assert c.request('POST', f"/imports/{saved['batch_id']}/undo", {}).status_code == 200
    assert c.snapshot()['operations'] == [original]
    preview, _ = review(c, identifier, a, ready_only=True)
    assert preview['new'] == 1 and preview['needs_category'] == 1


def test_partial_category_tenant_isolation_and_invalid_type(clients, runtime_engine):
    c, other = clients(), clients(); a = c.account(); b = other.account()
    identifier = batch(c, runtime_engine, statement())
    body = dict(account_id=a['id'], index=0, category_id=category(c)['id'], ready_only=True)
    assert other.request('POST', f'/imports/{identifier}/category', {**body, 'account_id': b['id']}).status_code == 404
    assert c.request('POST', f'/imports/{identifier}/category', {**body, 'category_id': category(other)['id']}).status_code == 404
    assert c.request('POST', f'/imports/{identifier}/category', {**body, 'category_id': category(c, 'income')['id']}).status_code == 422
    assert c.snapshot()['operations'] == []


def test_private_pdf_partial_save_and_repeat_without_confirming_unknowns(clients, runtime_engine):
    sample = os.environ.get('KASPI_SAMPLE_PDF')
    if not sample: pytest.skip('Private PDF not supplied')
    content = Path(sample).read_bytes(); parsed = parse_pdf(content)
    assert len(parsed['rows']) == 211
    c = clients()
    a = c.request('POST', '/accounts', dict(name='Disposable PDF fixture', kind='bank', currency='KZT',
        opening_date=parsed['start'], opening_balance_minor=parsed['opening_minor'])).json()
    headers = {'Origin': ORIGIN, 'X-CSRF-Token': csrf_token(c.raw), 'Content-Type': 'application/octet-stream'}
    uploaded = asyncio.run(c.http.post('/finance/imports/kaspi', content=content, headers=headers))
    assert uploaded.status_code == 201
    identifier = uploaded.json()['id']
    saved, _, preview = commit(c, identifier, a, ready_only=True)
    assert 0 < saved['added'] < 211 and saved['remaining'] > 0
    assert saved['added'] == preview['new']
    expected = int(parsed['opening_minor']) + sum(int(row['signed_minor']) for row in preview['rows'] if row['status'] == 'new')
    snapshot = c.snapshot()
    assert int(snapshot['accounts'][0]['balance_minor']) == expected
    assert snapshot['accounts'][0]['opening_balance_minor'] == parsed['opening_minor']
    with user_session(runtime_engine, c.uid) as session:
        assert session.get(ImportBatch, UUID(identifier)).payload['rows'] == parsed['rows']
        assert len(list(session.scalars(select(ImportMovement)))) == saved['added']
    repeated = asyncio.run(c.http.post('/finance/imports/kaspi', content=content, headers=headers)).json()['id']
    again, _ = review(c, repeated, a, ready_only=True)
    assert again['duplicates'] == saved['added'] and again['new'] == 0
    assert len(c.snapshot()['operations']) == saved['added']
    target = os.environ.get('IMPORT_PARTIAL_REPORT')
    if target: Path(target).write_text(json.dumps(dict(rows=211, added=saved['added'], remaining=saved['remaining'],
        needs_category=preview['needs_category'], financial_review=preview['financial_review'], repeat_duplicates=again['duplicates'],
        opening_unchanged=True, exact_balance=True, raw_rows_preserved=True), indent=2), encoding='utf-8')


def test_incomplete_match_and_invalid_transfer_do_not_block_ready_rows(clients, runtime_engine):
    c = clients(); a = c.account(); foreign_currency = c.account('USD', currency='USD')
    c.operation(a, amount='100', occurred_on='2026-01-05')
    identifier = batch(c, runtime_engine, statement((-100, -200, -300), ['Магазин X', 'Freedom Finance Bank *1234', 'Гелиос']))
    saved, _, preview = commit(c, identifier, a, [dict(index=0, action='match'),
        dict(index=1, kind='transfer', other_account_id=foreign_currency['id'], reviewed=True)], ready_only=True)
    assert preview['new'] == 1 and saved['added'] == 1 and saved['remaining'] == 2
    assert len(c.snapshot()['operations']) == 2


def test_partial_stale_revision_rejected_without_writing(clients, runtime_engine):
    c = clients(); a = c.account()
    identifier = batch(c, runtime_engine, statement((-100,), ['Гелиос']))
    preview, body = review(c, identifier, a, ready_only=True)
    c.operation(a, amount='50')
    before = c.snapshot()
    response = c.request('POST', f'/imports/{identifier}/commit', {**body, 'revision': preview['revision']})
    assert response.status_code == 409 and c.snapshot() == before


def test_new_category_creation_and_assignment_uses_existing_api(clients, runtime_engine):
    c = clients(); a = c.account()
    identifier = batch(c, runtime_engine, statement((-100, -200), ['Магазин X', 'Магазин X']))
    created = c.request('POST', '/categories', {'name': 'Личные покупки', 'kind': 'expense'})
    assert created.status_code == 201
    decision = assign(c, identifier, a, 0, created.json())
    saved, _, _ = commit(c, identifier, a, decision['choices'], ready_only=True)
    assert saved['added'] == 2
    assert all(o['category_id'] == created.json()['id'] for o in c.snapshot()['operations'])
