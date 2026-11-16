import asyncio
from copy import deepcopy
from datetime import date, timedelta
from hashlib import sha256
from uuid import UUID

import pytest
from sqlalchemy import select

from app.auth import csrf_token, now
from app.db import user_session
from app.models import ImportBatch, ImportMovement, ImportRule, Transaction
from app.kaspi_import import protected_digest
from app.kaspi_pdf import normalize
from test_finance_postgres import clients, pg_engine, runtime_engine, ORIGIN

pytestmark = pytest.mark.postgres


def statement(amounts=(-1000,), descriptions=None, start='2026-01-01', end='2026-01-10', opening=10000):
    counters, rows = {}, []
    for i, value in enumerate(amounts):
        description = descriptions[i] if descriptions else 'ИП Тест'
        kind = 'Перевод' if 'Freedom' in description or description == 'Другой человек' else 'Разное' if 'Комиссия' in description else 'Покупка'
        fp = sha256(f'2026-01-05|{value}|{kind}|{normalize(description)}'.encode()).hexdigest()
        counters[fp] = counters.get(fp, 0) + 1
        rows.append(dict(index=i, date='2026-01-05', signed_minor=str(value), bank_type=kind, description=description, extra='', fingerprint=fp, ordinal=counters[fp]))
    return dict(bank='kaspi', product='Kaspi Gold', currency='KZT', last_four='1111', start=start, end=end, opening_minor=str(opening), closing_minor=str(opening + sum(amounts)), rows=rows)


def batch(client, engine, value):
    with user_session(engine, client.uid) as session:
        row = ImportBatch(user_id=client.uid, file_hash=sha256(str(value).encode()).hexdigest(), bank_digest=protected_digest(client.uid, 'synthetic-bank'), payload=deepcopy(value), result={}, expires_at=now()+timedelta(hours=1))
        session.add(row); session.flush(); return str(row.id)


def review(client, identifier, account, choices=None, **extra):
    body = dict(account_id=account['id'], choices=choices or [], **extra)
    response = client.request('POST', f'/imports/{identifier}/review', body)
    assert response.status_code == 200, response.text
    return response.json(), body


def commit(client, identifier, account, choices=None, **extra):
    preview, body = review(client, identifier, account, choices, **extra)
    response = client.request('POST', f'/imports/{identifier}/commit', {**body, 'revision': preview['revision']})
    assert response.status_code == 200, response.text
    return response.json(), body, preview


def reviewed(count, **extra):
    return [dict(index=i, reviewed=True, **extra) for i in range(count)]


def test_repeat_overlap_and_identical_rows_preserve_multiplicity(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000')
    first = batch(c, runtime_engine, statement((-1000, -1000)))
    result, body, preview = commit(c, first, a, reviewed(2))
    assert result['added'] == 2
    assert c.snapshot()['balances']['KZT']['total_minor'] == '8000'
    # Same batch commit is idempotent, even if response delivery was lost.
    assert c.request('POST', f'/imports/{first}/commit', {**body, 'revision': preview['revision']}).json()['added'] == 2
    overlap = batch(c, runtime_engine, statement((-1000, -1000, -1000), end='2026-01-15'))
    proposed, _ = review(c, overlap, a)
    assert proposed['duplicates'] == 2 and proposed['review'] == 1
    result, _, _ = commit(c, overlap, a, reviewed(3))
    assert result['added'] == 1 and result['duplicates'] == 2
    repeated = batch(c, runtime_engine, statement((-1000, -1000)))
    result, _, _ = commit(c, repeated, a, acknowledge_difference=True)
    assert result['added'] == 0 and result['duplicates'] == 2
    assert len(c.snapshot()['operations']) == 3


def test_unknown_merchant_requires_review_and_rule_is_exact(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000')
    category = next(x for x in c.snapshot()['categories'] if x['kind'] == 'expense')
    identifier = batch(c, runtime_engine, statement())
    proposal, body = review(c, identifier, a)
    assert proposal['review'] == 1
    assert c.request('POST', f'/imports/{identifier}/commit', {**body, 'revision': proposal['revision']}).status_code == 422
    commit(c, identifier, a, reviewed(1, category_id=category['id'], remember_category=True))
    rules = c.request('GET', '/imports/rules').json(); assert len(rules) == 1
    next_statement = statement((-500, -200), ['ИП Тест', 'ИП Тест 2'])
    proposal, _ = review(c, batch(c, runtime_engine, next_statement), a)
    assert proposal['rows'][0]['category_id'] == category['id']
    assert not proposal['rows'][0]['requires_review']
    assert proposal['rows'][1]['requires_review']
    assert c.request('DELETE', '/imports/rules/' + rules[0]['id'], {'expected_version': rules[0]['version']}).status_code == 200


def test_own_freedom_rule_transfer_and_other_bank_side_match(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000'); b = c.account('Freedom', opening='0')
    identifier = batch(c, runtime_engine, statement((-1000,), ['Freedom Finance Bank *4396']))
    proposal, _ = review(c, identifier, a)
    assert proposal['rows'][0]['own_hint'] and proposal['review'] == 1
    commit(c, identifier, a, reviewed(1, kind='transfer', other_account_id=b['id'], remember_account=True))
    snap = c.snapshot(); transfer = snap['operations'][0]
    assert transfer['kind'] == 'transfer' and len(snap['operations']) == 1
    assert snap['balances']['KZT']['total_minor'] == '10000'
    proposal, _ = review(c, batch(c, runtime_engine, statement((-2000,), ['Freedom Finance Bank *4396'])), a)
    assert proposal['rows'][0]['kind'] == 'transfer' and proposal['rows'][0]['other_account_id'] == b['id']
    # Generic opposite-bank evidence can link the existing two-sided transaction;
    # this is not a Freedom parser and creates no second money movement.
    incoming = statement((1000,), ['С моей карты'], opening=0)
    other = batch(c, runtime_engine, incoming)
    with user_session(runtime_engine, c.uid) as session:
        session.get(ImportBatch, UUID(other)).bank_digest = protected_digest(c.uid, 'second-bank')
    commit(c, other, b, [dict(index=0, action='match', match_id=transfer['id'], reviewed=True, kind='transfer', other_account_id=a['id'])])
    assert len(c.snapshot()['operations']) == 1
    assert c.request('POST', f'/imports/{identifier}/undo', {}).status_code == 409


def test_external_transfer_commission_and_refund_not_ordinary_earnings(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000')
    value = statement((-1000, -149, 42, 1000), ['Другой человек', 'Комиссия за перевод', 'Курсовая разница', 'Отмена перевода'])
    identifier = batch(c, runtime_engine, value)
    commit(c, identifier, a, reviewed(4))
    snap = c.snapshot(); ops = snap['operations']
    assert sum(o['kind'] == 'transfer' for o in ops) == 0
    assert sum(o['adjustment_type'] is not None for o in ops) == 2
    assert snap['balances']['KZT']['total_minor'] == '9893'
    categories = {x['id']: x['name'] for x in snap['categories']}
    assert any(categories[o['category_id']] == 'Переводы людям' for o in ops)
    assert any(categories[o['category_id']] == 'Банковские комиссии' for o in ops)


def test_manual_candidate_not_overwritten_and_undo_only_import_created(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000')
    original, _ = c.operation(a, amount='1000', occurred_on='2026-01-05')
    identifier = batch(c, runtime_engine, statement((-1000, -200)))
    commit(c, identifier, a, [dict(index=0, action='match', match_id=original['id'], reviewed=True), dict(index=1, reviewed=True)])
    assert len(c.snapshot()['operations']) == 2
    assert c.request('POST', f'/imports/{identifier}/undo', {}).status_code == 200
    assert [o['id'] for o in c.snapshot()['operations']] == [original['id']]
    assert c.snapshot()['balances']['KZT']['total_minor'] == '9000'


def test_cancel_preview_does_not_change_finances_or_rules(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000'); before = c.snapshot()
    identifier = batch(c, runtime_engine, statement())
    review(c, identifier, a, reviewed(1, remember_category=True))
    assert c.request('DELETE', f'/imports/{identifier}/preview').status_code == 200
    assert c.snapshot() == before
    assert c.request('GET', '/imports/rules').json() == []


def test_rls_account_rules_batch_and_invalid_csrf(clients, runtime_engine):
    a, b = clients(), clients(); account = a.account(opening='10000'); foreign = b.account(opening='10000')
    identifier = batch(a, runtime_engine, statement())
    assert b.request('POST', f'/imports/{identifier}/review', {'account_id': foreign['id']}).status_code == 404
    assert a.request('POST', f'/imports/{identifier}/review', {'account_id': foreign['id']}).status_code == 404
    assert a.request('POST', f'/imports/{identifier}/review', {'account_id': account['id']}, headers={'Origin': ORIGIN}).status_code == 403
    with user_session(runtime_engine, b.uid) as session:
        assert list(session.scalars(select(ImportBatch))) == []


def test_commit_stale_revision_and_atomic_failure(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000')
    identifier = batch(c, runtime_engine, statement((-1000, -200)))
    proposal, body = review(c, identifier, a, reviewed(2))
    c.operation(a, amount='1', occurred_on='2026-01-06')
    assert c.request('POST', f'/imports/{identifier}/commit', {**body, 'revision': proposal['revision']}).status_code == 409
    # First row could create a category, but invalid second transfer rolls it all back.
    before = c.snapshot()
    choices = [dict(index=0, reviewed=True), dict(index=1, reviewed=True, kind='transfer', other_account_id=a['id'])]
    proposal, body = review(c, identifier, a, choices, acknowledge_difference=True)
    assert c.request('POST', f'/imports/{identifier}/commit', {**body, 'revision': proposal['revision']}).status_code == 422
    assert c.snapshot() == before


def test_opening_reconciliation_requires_explicit_confirmation(clients, runtime_engine):
    c = clients(); a = c.account(opening='99999')
    identifier = batch(c, runtime_engine, statement())
    proposal, body = review(c, identifier, a, reviewed(1))
    assert proposal['difference_minor'] != '0'
    assert c.request('POST', f'/imports/{identifier}/commit', {**body, 'revision': proposal['revision']}).status_code == 422
    commit(c, identifier, a, reviewed(1), use_statement_opening=True)
    assert c.snapshot()['balances']['KZT']['total_minor'] == '9000'
    assert c.request('POST', f'/imports/{identifier}/undo', {}).status_code == 200
    assert c.snapshot()['balances']['KZT']['total_minor'] == '99999'


def test_edited_import_is_not_overwritten_or_unsafely_undone(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000')
    identifier = batch(c, runtime_engine, statement()); commit(c, identifier, a, reviewed(1))
    op = c.snapshot()['operations'][0]
    changed = {k: op[k] for k in ('kind', 'occurred_on', 'account_id', 'destination_account_id', 'amount_minor', 'category_id')}
    changed.update(comment='Ручная правка', expected_version=op['version'], category_id=next(category['id'] for category in c.snapshot()['categories'] if category['kind'] == 'expense' and category['id'] != op['category_id']))
    assert c.request('PUT', '/operations/' + op['id'], changed).status_code == 200
    repeated = batch(c, runtime_engine, statement()); commit(c, repeated, a)
    assert c.snapshot()['operations'][0]['comment'] == 'Ручная правка'
    assert c.snapshot()['operations'][0]['category_id'] == changed['category_id']
    assert c.request('POST', f'/imports/{identifier}/undo', {}).status_code == 409


def test_upload_checks_content_and_keeps_only_parsed_preview(clients, monkeypatch):
    c = clients()
    headers = {'Origin': ORIGIN, 'X-CSRF-Token': csrf_token(c.raw), 'Content-Type': 'application/pdf'}
    response = asyncio.run(c.http.post('/finance/imports/kaspi', content=b'not pdf', headers=headers))
    assert response.status_code == 415
    value = statement(); value['account_digest'] = 'private-digest'
    monkeypatch.setattr('app.kaspi_import.parse_isolated', lambda content: deepcopy(value))
    response = asyncio.run(c.http.post('/finance/imports/kaspi', content=b'%PDF-synthetic-content', headers=headers))
    assert response.status_code == 201
    assert 'account_digest' not in response.text and 'private-digest' not in response.text
    assert c.snapshot()['operations'] == []


def test_historical_import_rebases_explicitly_without_double_count_and_undo_restores(clients, runtime_engine):
    c = clients()
    response = c.request('POST', '/accounts', dict(name='Новая история', kind='bank', currency='KZT', opening_date='2026-01-10', opening_balance_minor='9000'))
    a = response.json(); assert response.status_code == 201
    identifier = batch(c, runtime_engine, statement())
    proposed, body = review(c, identifier, a, reviewed(1))
    assert proposed['rows'][0]['status'] == 'before_opening'
    assert c.request('POST', f'/imports/{identifier}/commit', {**body, 'revision': proposed['revision']}).status_code == 422
    commit(c, identifier, a, reviewed(1), use_statement_opening=True)
    assert c.snapshot()['balances']['KZT']['total_minor'] == '9000'
    assert c.snapshot()['accounts'][0]['opening_date'] == '2026-01-01'
    assert c.request('POST', f'/imports/{identifier}/undo', {}).status_code == 200
    assert c.snapshot()['balances']['KZT']['total_minor'] == '9000'
    assert c.snapshot()['accounts'][0]['opening_date'] == '2026-01-10'


def test_simultaneous_commit_creates_one_set_of_movements(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000'); identifier = batch(c, runtime_engine, statement())
    proposal, body = review(c, identifier, a, reviewed(1))
    async def simultaneous():
        headers = {'Origin': ORIGIN, 'X-CSRF-Token': csrf_token(c.raw)}
        return await asyncio.gather(*[c.http.post(f'/finance/imports/{identifier}/commit', json={**body, 'revision': proposal['revision']}, headers=headers) for _ in range(2)])
    responses = asyncio.run(simultaneous())
    assert [r.status_code for r in responses] == [200, 200]
    assert len(c.snapshot()['operations']) == 1


def test_exact_purchase_refund_links_original_and_rule_edit_is_isolated(clients, runtime_engine):
    c = clients(); other = clients(); a = c.account(opening='10000')
    identifier = batch(c, runtime_engine, statement((-1000, 1000), ['Магазин', 'Магазин']))
    expense_category = next(x for x in c.snapshot()['categories'] if x['kind'] == 'expense')
    commit(c, identifier, a, [dict(index=0, reviewed=True, category_id=expense_category['id'], remember_category=True), dict(index=1, reviewed=True)])
    ops = c.snapshot()['operations']; correction = next(x for x in ops if x['adjustment_type'])
    assert correction['related_transaction_id'] == next(x for x in ops if not x['adjustment_type'])['id']
    rule = c.request('GET', '/imports/rules').json()[0]
    assert other.request('PUT', '/imports/rules/' + rule['id'], dict(expected_version=rule['version'], category_id=expense_category['id'])).status_code == 404
    next_category = next(x for x in c.snapshot()['categories'] if x['kind'] == 'expense' and x['id'] != expense_category['id'])
    assert c.request('PUT', '/imports/rules/' + rule['id'], dict(expected_version=rule['version'], category_id=next_category['id'])).status_code == 200
    assert c.request('POST', f'/imports/{identifier}/undo', {}).status_code == 200


@pytest.mark.parametrize('adjustment', ['refund', 'reversal', 'return_funds'])
def test_partial_returns_limit_edit_delete_and_period(clients, adjustment):
    c = clients(); a = c.account(opening='3000000')
    original, original_body = c.operation(a, amount='2000000', occurred_on='2026-01-15')
    refund, body = c.operation(a, 'income', '500000', occurred_on='2026-02-15',
        adjustment_type=adjustment, related_transaction_id=original['id'])
    assert refund['expense_correction_minor'] == '500000'
    assert refund['correction_category_id'] == original['category_id']
    assert refund['occurred_on'] == '2026-02-15' and not refund['adjustment_pending']
    c.operation(a, 'income', '1500000', occurred_on='2026-02-16',
        adjustment_type=adjustment, related_transaction_id=original['id'])
    before = c.snapshot()
    assert before['balances']['KZT']['total_minor'] == '3000000'
    assert c.request('POST', '/operations', {**body, 'amount_minor': '1'}).status_code == 422
    assert c.request('PUT', '/operations/' + refund['id'], {**body, 'amount_minor': '500001', 'expected_version': 1}).status_code == 422
    assert c.request('PUT', '/operations/' + original['id'], {**original_body, 'amount_minor': '1999999', 'expected_version': 1}).status_code == 422
    assert c.request('DELETE', '/operations/' + original['id'], {'expected_version': 1}).status_code == 409
    assert c.snapshot() == before
    assert c.request('PUT', '/operations/' + refund['id'], {**body, 'amount_minor': '400000', 'expected_version': 1}).status_code == 200
    assert c.snapshot()['balances']['KZT']['total_minor'] == '2900000'
    assert c.request('DELETE', '/operations/' + refund['id'], {'expected_version': 2}).status_code == 200
    assert c.snapshot()['balances']['KZT']['total_minor'] == '2500000'


def test_refund_import_repeat_and_overflow_stays_unconfirmed(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000')
    original, _ = c.operation(a, amount='1000', occurred_on='2026-01-04', comment='Магазин')
    first = batch(c, runtime_engine, statement((1000,), ['Магазин'], opening=9000))
    commit(c, first, a, reviewed(1))
    before = c.snapshot()
    refund = next(o for o in before['operations'] if o['adjustment_type'])
    assert refund['expense_correction_minor'] == '1000'
    repeated = batch(c, runtime_engine, statement((1000,), ['Магазин'], opening=9000))
    assert commit(c, repeated, a)[0]['added'] == 0
    assert c.snapshot() == before
    extra = batch(c, runtime_engine, statement((1000, 1000), ['Магазин', 'Магазин'], opening=9000))
    preview, body = review(c, extra, a, [dict(index=1, reviewed=True, related_id=original['id'])])
    assert c.request('POST', f'/imports/{extra}/commit', {**body, 'revision': preview['revision']}).status_code == 422
    assert c.snapshot() == before
    commit(c, extra, a, reviewed(2))
    unknown = next(o for o in c.snapshot()['operations'] if o['adjustment_pending'])
    assert unknown['expense_correction_minor'] == '0' and unknown['related_transaction_id'] is None


def test_external_reversal_category_and_own_reversal_two_sides(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000'); b = c.account('Freedom', opening='0')
    external, _ = c.operation(a, amount='1000', occurred_on='2026-01-04', comment='Получатель')
    value = statement((1000,), ['Получатель'], opening=9000)
    value['rows'][0]['bank_type'] = 'Отмена'
    identifier = batch(c, runtime_engine, value)
    commit(c, identifier, a, reviewed(1, related_id=external['id']))
    reverse = next(o for o in c.snapshot()['operations'] if o['adjustment_type'])
    assert reverse['adjustment_type'] == 'reversal' and reverse['expense_correction_minor'] == '1000'
    original, _ = c.operation(a, 'transfer', '2000', b, occurred_on='2026-01-04')
    identifier = batch(c, runtime_engine, statement((2000,), ['Отмена перевода Freedom *4396'], opening=8000))
    preview, body = review(c, identifier, a, reviewed(1, related_id=original['id']))
    assert c.request('POST', f'/imports/{identifier}/commit', {**body, 'revision': preview['revision']}).status_code == 422
    commit(c, identifier, a, reviewed(1, kind='transfer', other_account_id=b['id']))
    snap = c.snapshot()
    assert {o['id']: o['balance_minor'] for o in snap['accounts']} == {a['id']: '10000', b['id']: '0'}
    assert len([o for o in snap['operations'] if o['kind'] == 'transfer']) == 2
    assert c.request('POST', f'/imports/{identifier}/undo', {}).status_code == 200
    assert {o['id']: o['balance_minor'] for o in c.snapshot()['accounts']} == {a['id']: '8000', b['id']: '2000'}


def test_fx_and_unknown_refund_are_not_income_and_cannot_cross_tenants(clients, runtime_engine):
    c, foreign = clients(), clients(); a = c.account(opening='10000'); b = foreign.account()
    purchase, _ = c.operation(a, amount='1000', occurred_on='2026-01-04', comment='Riot')
    identifier = batch(c, runtime_engine, statement((42,), ['Riot'], opening=9000))
    with user_session(runtime_engine, c.uid) as session:
        row = session.get(ImportBatch, UUID(identifier)); value = deepcopy(row.payload)
        value['rows'][0]['extra'] = 'Курсовая разница'; row.payload = value
    commit(c, identifier, a, reviewed(1, related_id=purchase['id']))
    fx = next(o for o in c.snapshot()['operations'] if o['adjustment_type'])
    assert fx['adjustment_type'] == 'fx' and fx['expense_correction_minor'] == '0'
    assert c.snapshot()['balances']['KZT']['total_minor'] == '9042'
    foreign_op, _ = foreign.operation(b, amount='1000', occurred_on='2026-01-04')
    income_cat = next(o['id'] for o in c.snapshot()['categories'] if o['kind'] == 'income')
    body = dict(kind='income', account_id=a['id'], category_id=income_cat, amount_minor='100', occurred_on='2026-01-05', adjustment_type='refund', related_transaction_id=foreign_op['id'])
    assert c.request('POST', '/operations', body).status_code == 404
    body['related_transaction_id'] = None
    unknown = c.request('POST', '/operations', body)
    assert unknown.status_code == 201 and unknown.json()['adjustment_pending']
    assert unknown.json()['expense_correction_minor'] == '0'


def test_known_category_identical_rows_still_require_confirmation(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000')
    identifier = batch(c, runtime_engine, statement((-1000, -1000), ['Гелиос', 'Гелиос']))
    preview, _ = review(c, identifier, a)
    assert preview['review'] == 2
    commit(c, identifier, a, reviewed(2))
    assert len(c.snapshot()['operations']) == 2


def test_october_november_overlap_and_unchanged_historical_balance(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000')
    first = statement((-1000,), start='2026-10-01', end='2026-10-31')
    first['rows'][0]['date'] = '2026-10-05'
    first['rows'][0]['fingerprint'] = sha256(b'october-row').hexdigest()
    commit(c, batch(c, runtime_engine, first), a, reviewed(1))
    expanded = deepcopy(first); expanded['end'] = '2026-11-10'; expanded['closing_minor'] = '8500'
    extra = deepcopy(first['rows'][0]); extra.update(index=1, date='2026-11-05', signed_minor='-500', fingerprint=sha256(b'november-row').hexdigest())
    expanded['rows'].append(extra)
    result, _, _ = commit(c, batch(c, runtime_engine, expanded), a, reviewed(2))
    assert result['added'] == 1 and result['duplicates'] == 1
    before = c.snapshot()
    assert commit(c, batch(c, runtime_engine, expanded), a)[0]['added'] == 0
    assert c.snapshot() == before
    from app.finance import balances
    from app.models import Account
    with user_session(runtime_engine, c.uid) as session:
        accounts = list(session.scalars(select(Account))); operations = list(session.scalars(select(Transaction)))
        assert balances(accounts, operations, date(2026, 10, 31))[0][UUID(a['id'])] == 9000
        assert balances(accounts, operations, date(2026, 11, 10))[0][UUID(a['id'])] == 8500


def test_original_category_edits_propagate_and_later_refund_guards_undo(clients, runtime_engine):
    c = clients(); a = c.account(opening='10000')
    identifier = batch(c, runtime_engine, statement((-1000,), ['Магазин']))
    commit(c, identifier, a, reviewed(1))
    original = c.snapshot()['operations'][0]
    refund, _ = c.operation(a, 'income', '500', occurred_on='2026-02-01', adjustment_type='refund', related_transaction_id=original['id'])
    assert c.request('POST', f'/imports/{identifier}/undo', {}).status_code == 409
    category = next(o['id'] for o in c.snapshot()['categories'] if o['kind'] == 'expense' and o['id'] != original['category_id'])
    body = {key: original[key] for key in ('kind', 'occurred_on', 'account_id', 'amount_minor')}
    assert c.request('PUT', '/operations/' + original['id'], {**body, 'category_id': category, 'expected_version': 1}).status_code == 200
    linked = next(o for o in c.snapshot()['operations'] if o['id'] == refund['id'])
    assert linked['correction_category_id'] == category and linked['expense_correction_minor'] == '500'
