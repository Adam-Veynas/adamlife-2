"""iPhone regressions against isolated local PostgreSQL, never production."""
import asyncio
from collections import Counter
from datetime import date, timedelta
import json
import os
from pathlib import Path
from time import perf_counter
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.auth import csrf_token
from app.kaspi_import import suggest
from app.kaspi_pdf import parse_pdf
from test_finance_postgres import clients, pg_engine, runtime_engine, ORIGIN

pytestmark = pytest.mark.postgres


@pytest.mark.parametrize('merchant,category', [('OPENAI*CHATGPT SUBSCR', 'Подписки'), ('YANDEX.PLUS', 'Подписки'), (' Tele2 ', 'Связь'), ('Гелиос', 'Топливо'), ('Банковская комиссия', 'Банковские комиссии')])
def test_known_merchant_spelling(merchant, category):
    result = suggest(dict(description=merchant, extra='', bank_type='Покупка', signed_minor='-100'), [], [])
    assert result['category_name'] == category and not result['requires_review']
    bad = suggest(dict(description=merchant + ' неизвестный', extra='', bank_type='Покупка', signed_minor='-100'), [], [])
    if 'комисси' not in merchant.lower(): assert bad['requires_review']


def test_user_rule_precedes_builtin_and_commission_alias_is_reused():
    category = SimpleNamespace(id=uuid4(), kind='expense', name='Моя категория', archived_at=None)
    rule = SimpleNamespace(rule_type='category', key='openai*chatgpt subscr', category_kind='expense', category_id=category.id)
    result = suggest(dict(description='OPENAI*CHATGPT SUBSCR', extra='', bank_type='Покупка', signed_minor='-100'), [rule], [category])
    assert result['category_id'] == str(category.id)
    category.name = 'Комиссии'
    result = suggest(dict(description='Комиссия за перевод', extra='', bank_type='Разное', signed_minor='-100'), [], [category])
    assert result['category_id'] == str(category.id) and result['category_name'] == 'Комиссии'


def test_private_pdf_upload_commit_repeat_in_disposable_database(clients):
    sample = os.environ.get('KASPI_SAMPLE_PDF')
    if not sample: pytest.skip('Private sample stays outside source control')
    content = Path(sample).read_bytes()
    statement = parse_pdf(content)
    assert len(statement['rows']) == 211
    c = clients()
    # Reproduce a newly created account whose baseline already includes old history.
    a = c.request('POST', '/accounts', dict(name='Isolated PDF fixture', kind='bank', currency='KZT',
        opening_date=str(date.fromisoformat(statement['end']) + timedelta(days=1)), opening_balance_minor=statement['closing_minor'])).json()
    headers = {'Origin': ORIGIN, 'X-CSRF-Token': csrf_token(c.raw)}
    def upload(mime):
        response = asyncio.run(c.http.post('/finance/imports/kaspi', content=content, headers={**headers, 'Content-Type': mime}))
        assert response.status_code == 201, response.text
        return response.json()['id']
    first = upload('application/octet-stream')
    assert c.request('DELETE', f'/imports/{first}/preview').status_code == 200
    identifier = upload('application/pdf')
    body = dict(account_id=a['id'])
    response = c.request('POST', f'/imports/{identifier}/review', body)
    assert response.status_code == 200
    initial = response.json()
    assert initial['before_opening'] == 211
    assert c.request('POST', f'/imports/{identifier}/commit', {**body, 'revision': initial['revision']}).status_code == 422
    body['use_statement_opening'] = True
    proposed = c.request('POST', f'/imports/{identifier}/review', body).json()
    assert proposed['difference_minor'] == '0'
    # Fixture explicitly reviews only exceptions. This is not inferred consent for a real import.
    body['choices'] = [dict(index=row['index'], reviewed=True) for row in proposed['rows'] if row['status'] == 'review']
    checked = c.request('POST', f'/imports/{identifier}/review', body).json()
    assert checked['review'] == 0 and checked['difference_minor'] == '0'
    started = perf_counter()
    result = c.request('POST', f'/imports/{identifier}/commit', {**body, 'revision': checked['revision']})
    assert result.status_code == 200, result.text
    assert result.json()['added'] == 211
    snap = c.snapshot()
    assert len(snap['operations']) == 211 and snap['accounts'][0]['balance_minor'] == statement['closing_minor']
    second = upload('')
    repeated = c.request('POST', f'/imports/{second}/review', dict(account_id=a['id'])).json()
    assert repeated['duplicates'] == 211 and repeated['review'] == 0
    repeated_result = c.request('POST', f'/imports/{second}/commit', dict(account_id=a['id'], revision=repeated['revision']))
    assert repeated_result.status_code == 200 and repeated_result.json()['added'] == 0
    assert len(c.snapshot()['operations']) == 211
    counts = Counter(row['category_name'] for row in proposed['rows'] if row['status'] == 'new')
    report = {'rows': 211, 'automatically_ready': proposed['new'], 'requires_review': proposed['review'],
        'known_categories': dict(counts), 'added': 211, 'repeat_added': 0, 'repeat_duplicates': 211,
        'balanced': True, 'commit_and_repeat_seconds': round(perf_counter() - started, 2)}
    target = os.environ.get('IMPORT_SMOKE_REPORT')
    if target: Path(target).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


def test_empty_or_truncated_upload_is_not_called_invalid_pdf(clients):
    c = clients()
    headers = {'Origin': ORIGIN, 'X-CSRF-Token': csrf_token(c.raw), 'Content-Type': 'application/pdf'}
    for content, extra in [(b'', {}), (b'%PDF-short', {'Content-Length': '100'})]:
        response = asyncio.run(c.http.post('/finance/imports/kaspi', content=content, headers={**headers, **extra}))
        assert response.status_code == 422 and response.json()['error']['code'] == 'PDF_UPLOAD_INCOMPLETE'
