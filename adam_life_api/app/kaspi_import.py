"""User-scoped preview/commit workflow over the existing ledger, never a second ledger."""
from collections import Counter
from datetime import date, timedelta
from hashlib import sha256
import json
import re
import subprocess
import sys
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import Field
from sqlalchemy import delete, select
from starlette.concurrency import run_in_threadpool

from app.auth import now
from app.finance import Input, OperationInput, audit, balances, fail, finance_session, operation_data, operation_values, owned, payment_guard, touch, version, validate_adjustment
from app.kaspi_pdf import MAX_BYTES, normalize
from app.models import Account, BankBinding, Category, ImportBatch, ImportMovement, ImportRule, Transaction

router = APIRouter(prefix='/finance/imports', tags=['Kaspi import'])


class Choice(Input):
    index: int = Field(ge=0, le=5000)
    action: Literal['add', 'skip', 'match'] = 'add'
    kind: Literal['income', 'expense', 'transfer', 'adjustment'] | None = None
    category_id: UUID | None = None
    other_account_id: UUID | None = None
    match_id: UUID | None = None
    related_id: UUID | None = None
    reviewed: bool = False
    remember_category: bool = False
    remember_account: bool = False


class ReviewInput(Input):
    account_id: UUID
    choices: list[Choice] = Field(default_factory=list, max_length=5000)
    use_statement_opening: bool = False
    revision: str | None = None
    acknowledge_difference: bool = False
    ready_only: bool = False


class CategoryAssignment(ReviewInput):
    index: int = Field(ge=0, le=5000)
    category_id: UUID
    remember: bool = True


class RuleInput(Input):
    category_id: UUID | None = None
    account_id: UUID | None = None
    expected_version: int = Field(ge=1)


def protected_digest(uid, digest):
    return sha256(f'{uid}:kaspi:{digest}'.encode()).hexdigest()


def parse_isolated(content):
    try:
        result = subprocess.run([sys.executable, '-m', 'app.kaspi_worker'], input=content, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=20, check=True)
        value = json.loads(result.stdout)
    except (subprocess.SubprocessError, ValueError):
        fail('PDF_PARSE_FAILED', 'Не удалось безопасно прочитать PDF. Сформируйте выписку за меньший период.', 422)
    if 'error' in value:
        fail('PDF_UNSUPPORTED', value['error'], 422)
    return value['statement']


@router.post('/kaspi', status_code=201)
async def upload(request: Request, auth=Depends(finance_session)):
    # Browser File.type can be empty/octet-stream. Validate the bounded bytes, not MIME.
    if request.headers.get('content-type', '').lower().startswith('multipart/'):
        fail('PDF_UPLOAD_FORMAT', 'Передайте PDF как файл без multipart-обёртки.', 415)
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_BYTES:
            fail('PDF_TOO_LARGE', 'Размер PDF не должен превышать 5 МБ.', 413)
    expected = request.headers.get('content-length')
    if not data or (expected and expected.isdigit() and int(expected) != len(data)):
        fail('PDF_UPLOAD_INCOMPLETE', 'Файл передан не полностью. Выберите сохранённый на устройстве PDF ещё раз.', 422)
    if not data.startswith(b'%PDF-'):
        fail('PDF_REQUIRED', 'Содержимое файла не является PDF.', 415)
    statement = await run_in_threadpool(parse_isolated, bytes(data))
    session, uid = auth
    # No PDF survives the request; expired previews are cleared on subsequent uploads.
    for expired in session.scalars(select(ImportBatch).where(ImportBatch.status == 'draft', ImportBatch.expires_at < now())):
        expired.status, expired.payload = 'cancelled', {}
    digest = protected_digest(uid, statement.pop('account_digest'))
    binding = session.scalar(select(BankBinding).where(BankBinding.bank_digest == digest))
    batch = ImportBatch(user_id=uid, file_hash=sha256(data).hexdigest(), bank_digest=digest, account_id=binding.account_id if binding else None,
                        payload=statement, result={}, expires_at=now() + timedelta(hours=24))
    session.add(batch); session.flush()
    return dict(id=str(batch.id), account_id=str(batch.account_id) if batch.account_id else None,
                statement={k: v for k, v in statement.items() if k != 'rows'}, found=len(statement['rows']))


def draft(session, identifier):
    batch = owned(session, ImportBatch, identifier)
    if batch.status != 'draft' or batch.expires_at < now():
        fail('PREVIEW_EXPIRED', 'Предпросмотр закрыт или истёк. Загрузите выписку снова.')
    return batch


def signed_movement(row, account_id):
    return (row.destination_amount_minor or 0) * (row.destination_account_id == account_id) - (row.source_amount_minor or 0) * (row.source_account_id == account_id)


def suggest(row, rules, categories):
    description = normalize(row['description']), normalize(row['extra'])
    full = ' '.join((*description, normalize(row['bank_type'])))
    positive = int(row['signed_minor']) > 0
    kind = 'income' if positive else 'expense'
    adjustment = 'reversal' if 'отмена' in full else 'fx' if 'курсов' in full else 'refund' if ('возврат' in full or (positive and row['bank_type'] == 'Покупка')) else None
    own = next((rule for rule in rules if rule.rule_type == 'own_account' and rule.key == description[0]), None)
    rule = next((rule for rule in rules if rule.rule_type == 'category' and rule.key == description[0] and rule.category_kind == kind), None)
    merchant = re.sub(r'[.*_]+', ' ', description[0])
    merchant = ' '.join(merchant.split())
    category_name, review = 'Другое', True
    if 'комисси' in full:
        category_name, review = 'Банковские комиссии', False
    elif row['bank_type'] == 'Перевод' and not positive:
        category_name, review = 'Переводы людям', False
    elif 'зарплат' in full and positive:
        category_name, review = 'Зарплата', False
    elif merchant in ('гелиос', 'helios', 'тоо гелиос'):
        category_name, review = 'Топливо', False
    elif merchant in ('tele2', 'теле2'):
        category_name, review = 'Связь', False
    elif merchant in ('openai chatgpt subscr', 'yandex plus'):
        category_name, review = 'Подписки', False
    names = {normalize(category_name)}
    if category_name == 'Банковские комиссии': names.add('комиссии')
    category = next((c for c in categories if c.kind == kind and normalize(c.name) in names and not c.archived_at), None)
    if category: category_name = category.name
    if rule:
        matched = next((c for c in categories if c.id == rule.category_id and not c.archived_at), None)
        if matched: category, category_name, review = matched, matched.name, False
    # Bank/card references are offered for explicit ownership confirmation, never hardcoded.
    own_hint = 'свой' in normalize(row['bank_type']) or 'своих' in full or 'своего' in full or ('*' in full and ('bank' in full or 'банк' in full))
    return dict(kind='transfer' if own else 'adjustment' if adjustment else kind, category_id=str(category.id) if category else None,
                category_name=category_name, other_account_id=str(own.account_id) if own else None,
                adjustment_type=adjustment, needs_category=bool(review and not own and not adjustment), requires_review=bool(adjustment or (not own and (review or own_hint))), own_hint=bool(own or own_hint))


def ledger_revision(accounts, operations, rules, evidence):
    value = ([sorted((str(a.id), a.version) for a in accounts), sorted((str(o.id), o.version, bool(o.deleted_at)) for o in operations),
              sorted((str(r.id), r.version) for r in rules), sorted(str(e.id) for e in evidence)])
    return sha256(json.dumps(value).encode()).hexdigest()


def prepare(session, batch, body):
    account = owned(session, Account, body.account_id)
    if account.currency != 'KZT' or account.kind != 'bank' or account.archived_at:
        fail('IMPORT_ACCOUNT', 'Выберите активный банковский счёт в KZT.', 422)
    binding = session.scalar(select(BankBinding).where(BankBinding.bank_digest == batch.bank_digest))
    other_binding = session.scalar(select(BankBinding).where(BankBinding.account_id == account.id))
    if (binding and binding.account_id != account.id) or (other_binding and other_binding.bank_digest != batch.bank_digest):
        fail('IMPORT_BINDING', 'Эта выписка уже связана с другим счётом. Привязка не изменена.')
    accounts = list(session.scalars(select(Account)))
    operations = list(session.scalars(select(Transaction)))
    categories = list(session.scalars(select(Category)))
    rules = list(session.scalars(select(ImportRule)))
    evidence = list(session.scalars(select(ImportMovement)))
    known = {(e.fingerprint, e.ordinal): e for e in evidence if e.bank_digest == batch.bank_digest}
    counts = Counter(e.fingerprint for e in known.values())
    incoming_counts = Counter(r['fingerprint'] for r in batch.payload['rows'])
    by_movement = {}
    for operation in operations:
        if not operation.deleted_at:
            by_movement.setdefault((str(operation.occurred_on), signed_movement(operation, account.id)), []).append(operation)
    choices = {c.index: c for c in body.choices}
    if len(choices) != len(body.choices) or any(index >= len(batch.payload['rows']) for index in choices):
        fail('IMPORT_CHOICES', 'Список решений не соответствует выписке.', 422)
    selected, used_matches = [], set()
    for raw in batch.payload['rows']:
        suggestion = suggest(raw, rules, categories)
        choice = choices.get(raw['index'], Choice(index=raw['index']))
        previous = known.get((raw['fingerprint'], raw['ordinal']))
        same = by_movement.get((raw['date'], int(raw['signed_minor'])), [])
        item = {**raw, **suggestion, 'action': choice.action, 'duplicate_id': str(previous.transaction_id) if previous else None,
                'candidates': [operation_data(o) for o in same], 'reviewed': choice.reviewed, 'related_id': str(choice.related_id) if choice.related_id else None,
                'remember_category': choice.remember_category, 'remember_account': choice.remember_account}
        if choice.kind: item['kind'] = choice.kind
        if choice.category_id: item['category_id'] = str(choice.category_id)
        if choice.other_account_id: item['other_account_id'] = str(choice.other_account_id)
        if choice.category_id:
            category = owned(session, Category, choice.category_id)
            if category.archived_at or category.kind != ('income' if int(raw['signed_minor']) > 0 else 'expense'):
                fail('IMPORT_CATEGORY', 'Выберите активную категорию нужного типа.', 422)
            item['category_name'] = category.name
            item['needs_category'] = False
        reasons = []
        if body.ready_only and not item['category_id'] and item['kind'] in ('income', 'expense') and any(c.kind == item['kind'] and normalize(c.name) == normalize(item['category_name']) and c.archived_at for c in categories):
            item['needs_category'] = True
        if item['needs_category'] and item['kind'] in ('income', 'expense'): reasons.append('category')
        if suggestion['own_hint'] and not suggestion['other_account_id']: reasons.append('ownership')
        if suggestion['adjustment_type']: reasons.append('adjustment')
        if same and not previous: reasons.append('match')
        # Two equal rows in one bank statement are two movements. Only overlap with
        # earlier evidence is ambiguous; ordinal remains part of the identity.
        # Preserve the legacy all-or-nothing endpoint's explicit confirmation.
        # The ready-only workflow retains both equal bank rows by their ordinals.
        if (counts[raw['fingerprint']] or (not body.ready_only and incoming_counts[raw['fingerprint']] > 1)) and not previous: reasons.append('overlap')
        item['review_reasons'] = [] if choice.reviewed else reasons
        item['requires_review'] = bool(item['review_reasons'])
        item['status'] = 'duplicate' if previous else 'skip' if choice.action == 'skip' else 'review' if item['requires_review'] else 'new'
        if choice.action == 'match' and not previous:
            if body.ready_only and not choice.match_id:
                item['status'] = 'review'
                item['review_reasons'].append('match')
                selected.append(item)
                continue
            if not choice.match_id or str(choice.match_id) in used_matches or not any(o.id == choice.match_id for o in same):
                fail('IMPORT_MATCH', 'Совпадение должно иметь ту же дату, сумму и счёт и использоваться только один раз.', 422)
            # Do not merge extra identical bank rows into an already evidenced movement on this bank account.
            if any(e.bank_digest == batch.bank_digest and e.transaction_id == choice.match_id for e in evidence):
                fail('IMPORT_MATCH', 'Эта операция уже сопоставлена с другой строкой выписки.', 422)
            matched = next(o for o in same if o.id == choice.match_id)
            actual_kind = 'adjustment' if matched.adjustment_type else matched.kind
            if item['kind'] != actual_kind:
                fail('IMPORT_MATCH_KIND', 'Тип существующей записи отличается. Исправьте его в истории или пересмотрите решение; импорт не перезаписывает операции.', 422)
            if actual_kind == 'transfer' and item['other_account_id']:
                other_id = matched.destination_account_id if matched.source_account_id == account.id else matched.source_account_id
                if str(other_id) != item['other_account_id']:
                    fail('IMPORT_MATCH_ACCOUNT', 'У существующего перевода другой второй счёт.', 422)
            used_matches.add(str(choice.match_id)); item['match_id'] = str(choice.match_id)
        if item['kind'] == 'transfer' and item['adjustment_type'] and not previous:
            item['requires_review'] = True
            if not choice.reviewed and choice.action != 'skip': item['status'] = 'review'
        if item['kind'] == 'transfer' and not item['other_account_id'] and not previous and choice.action == 'add':
            item['status'] = 'review'
            item['review_reasons'].append('transfer_account')
        if body.ready_only and item['kind'] == 'transfer' and item['other_account_id'] and item['status'] == 'new':
            other = next((a for a in accounts if str(a.id) == item['other_account_id']), None)
            if not other or other.id == account.id or other.archived_at or other.currency != account.currency or date.fromisoformat(item['date']) < other.opening_date:
                item['status'] = 'review'
                item['review_reasons'].append('transfer_account')
        selected.append(item)
    # Rebase is explicit and transactional. Existing opening balances are never overwritten implicitly.
    start, end = date.fromisoformat(batch.payload['start']), date.fromisoformat(batch.payload['end'])
    if body.use_statement_opening:
        if any(o.occurred_on < start and (o.source_account_id == account.id or o.destination_account_id == account.id) for o in operations):
            fail('IMPORT_OPENING', 'Начало выписки исключает существующую историю. Сохраните текущую дату учёта.', 422)
    boundary = start if body.use_statement_opening else account.opening_date
    for item in selected:
        if item['status'] not in ('skip', 'duplicate') and date.fromisoformat(item['date']) < boundary:
            item['status'] = 'before_opening'
            item['review_reasons'].append('before_opening')
    before = balances(accounts, operations, end)[0][account.id]
    projected = before
    if body.use_statement_opening:
        projected += int(batch.payload['opening_minor']) - (account.opening_balance_minor if account.opening_date <= end else 0)
    projected += sum(int(item['signed_minor']) for item in selected if (item['status'] == 'new' if body.ready_only else item['status'] not in ('skip', 'duplicate', 'before_opening')) and item['action'] == 'add')
    return dict(rows=selected, revision=ledger_revision(accounts, operations, rules, evidence), before_minor=str(before), projected_minor=str(projected),
                difference_minor=str(projected - int(batch.payload['closing_minor'])), opening_date=str(account.opening_date), opening_minor=str(account.opening_balance_minor),
                needs_category=sum(i['status'] == 'review' and i['review_reasons'] == ['category'] for i in selected),
                financial_review=sum(i['status'] in ('review', 'before_opening') and i['review_reasons'] != ['category'] for i in selected),
                preliminary=any(i['status'] in ('review', 'before_opening', 'skip') for i in selected) or projected != int(batch.payload['closing_minor']),
                before_opening=sum(i['status'] == 'before_opening' for i in selected),
                found=len(selected), duplicates=sum(i['status'] == 'duplicate' for i in selected),
                review=sum(i['status'] in ('review', 'before_opening') for i in selected),
                new=sum(i['status'] == 'new' for i in selected), own_transfers=sum(i['kind'] == 'transfer' or i['own_hint'] for i in selected)), account


@router.post('/{identifier}/review')
def review(identifier: UUID, body: ReviewInput, auth=Depends(finance_session)):
    session, _ = auth
    return prepare(session, draft(session, identifier), body)[0]


def ensure_category(session, uid, kind, name, identifier):
    if identifier:
        row = owned(session, Category, UUID(identifier))
        if row.kind != kind or row.archived_at: fail('IMPORT_CATEGORY', 'Выберите активную категорию нужного типа.', 422)
        return row
    candidates = list(session.scalars(select(Category).where(Category.kind == kind)))
    row = next((c for c in candidates if normalize(c.name) == normalize(name)), None)
    if row and row.archived_at: fail('IMPORT_CATEGORY', 'Категория находится в архиве. Выберите другую.', 422)
    if row is None:
        row = Category(user_id=uid, kind=kind, name=name); session.add(row); session.flush()
        audit(session, uid, row, 'created_by_import', {'kind': kind})
    return row


def remember(session, uid, item, category, other):
    for enabled, rule_type in [(item['remember_category'], 'category'), (item['remember_account'], 'own_account')]:
        if not enabled: continue
        if (rule_type == 'category' and category is None) or (rule_type == 'own_account' and other is None):
            fail('IMPORT_RULE', 'Для правила выберите категорию или собственный счёт.', 422)
        key = normalize(item['description'])
        if not key or len(key) > 1000: fail('IMPORT_RULE', 'Название не подходит для правила.', 422)
        rule = session.scalar(select(ImportRule).where(ImportRule.key == key, ImportRule.rule_type == rule_type))
        if rule is None:
            rule = ImportRule(user_id=uid, key=key, original=item['description'], rule_type=rule_type); session.add(rule)
        else: touch(rule)
        rule.category_id, rule.category_kind = (category.id, category.kind) if rule_type == 'category' else (None, None)
        rule.account_id = other.id if rule_type == 'own_account' else None
        session.flush(); audit(session, uid, rule, 'rule_saved', {'type': rule_type})


@router.post('/{identifier}/category')
def assign_category(identifier: UUID, body: CategoryAssignment, auth=Depends(finance_session)):
    session, uid = auth
    batch = draft(session, identifier)
    preview, _ = prepare(session, batch, body)
    if body.index >= len(preview['rows']): fail('IMPORT_CHOICES', 'Строка не найдена.', 422)
    selected = preview['rows'][body.index]
    if selected['kind'] not in ('income', 'expense') or selected['status'] in ('duplicate', 'skip'):
        fail('IMPORT_CATEGORY', 'Для перевода или возврата сначала уточните финансовый смысл.', 422)
    category = owned(session, Category, body.category_id)
    kind = 'income' if int(selected['signed_minor']) > 0 else 'expense'
    if category.kind != kind or category.archived_at: fail('IMPORT_CATEGORY', 'Выберите активную категорию нужного типа.', 422)
    choices = {c.index: c for c in body.choices}
    for row in preview['rows']:
        existing = choices.get(row['index'], Choice(index=row['index']))
        if row['status'] in ('duplicate', 'skip') or row['kind'] not in ('income', 'expense'): continue
        if normalize(row['description']) != normalize(selected['description']) or (int(row['signed_minor']) > 0) != (kind == 'income'): continue
        if row['index'] != body.index and existing.category_id: continue
        choices[row['index']] = existing.model_copy(update={'category_id': category.id, 'remember_category': False})
    if body.remember:
        remember(session, uid, {**selected, 'remember_category': True, 'remember_account': False}, category, None)
    updated = body.model_copy(update={'choices': list(choices.values())})
    result, _ = prepare(session, batch, updated)
    return {'review': result, 'choices': [c.model_dump(mode='json') for c in choices.values()]}


@router.post('/{identifier}/commit')
def commit(identifier: UUID, body: ReviewInput, auth=Depends(finance_session)):
    session, uid = auth
    batch = owned(session, ImportBatch, identifier)
    request_key = sha256(body.model_dump_json().encode()).hexdigest()
    if body.ready_only and batch.result.get('request_key') == request_key: return batch.result['response']
    if batch.status == 'committed': return batch.result
    batch = draft(session, identifier)
    preview, account = prepare(session, batch, body)
    if not body.revision or body.revision != preview['revision']:
        fail('IMPORT_CHANGED', 'Данные изменились. Обновите предпросмотр перед сохранением.')
    if body.ready_only and body.use_statement_opening:
        fail('IMPORT_OPENING', 'Частичный импорт не меняет начальный остаток и дату учёта.', 422)
    if preview['review'] and not body.ready_only:
        fail('IMPORT_REVIEW', 'Проверьте неоднозначные строки или исключите их. Для старой истории согласуйте дату начала учёта.', 422)
    if preview['difference_minor'] != '0' and not body.acknowledge_difference and not body.ready_only:
        fail('IMPORT_RECONCILE', 'Расчётный остаток отличается от выписки. Подтвердите расхождение; баланс автоматически не исправляется.', 422)
    source_batch = batch
    if body.ready_only:
        if not preview['new']: fail('IMPORT_NOT_READY', 'Пока нет новых готовых операций.', 422)
        # Each saved portion is a normal committed import (including existing undo).
        # Keep the original draft intact so unresolved rows can be reviewed later.
        batch = ImportBatch(user_id=uid, file_hash=batch.file_hash, bank_digest=batch.bank_digest,
                            account_id=account.id, payload={k: v for k, v in batch.payload.items() if k != 'rows'},
                            result={}, expires_at=batch.expires_at)
        session.add(batch); session.flush()
    baseline = None
    if body.use_statement_opening:
        baseline = dict(date=str(account.opening_date), amount=str(account.opening_balance_minor), version=account.version)
        account.opening_date, account.opening_balance_minor = date.fromisoformat(batch.payload['start']), int(batch.payload['opening_minor'])
        touch(account); session.flush()
        audit(session, uid, account, 'import_opening_confirmed', {'batch': str(batch.id), 'before': baseline})
    created, references, skipped, adjustments = [], [], 0, []
    for item in preview['rows']:
        if item['status'] == 'duplicate':
            references.append(item['duplicate_id']); continue
        if item['action'] == 'skip': skipped += 1; continue
        if body.ready_only and item['status'] != 'new': continue
        if item['action'] == 'match':
            transaction = owned(session, Transaction, UUID(item['match_id']))
            category = owned(session, Category, UUID(item['category_id'])) if item['remember_category'] and item['category_id'] else session.get(Category, transaction.category_id) if transaction.category_id else None
            if category and category.archived_at: fail('IMPORT_CATEGORY', 'Категория находится в архиве.', 422)
            other_id = transaction.destination_account_id if transaction.source_account_id == account.id else transaction.source_account_id
            other = owned(session, Account, other_id) if transaction.kind == 'transfer' else None
            remember(session, uid, item, category, other)
        else:
            positive = int(item['signed_minor']) > 0
            kind = 'income' if positive else 'expense'
            other, category = None, None
            if item['kind'] == 'transfer':
                other = owned(session, Account, UUID(item['other_account_id']))
                kind = 'transfer'
            elif item['kind'] not in (kind, 'adjustment'):
                fail('IMPORT_SIGN', 'Тип не соответствует знаку банковского движения.', 422)
            if kind != 'transfer':
                category = ensure_category(session, uid, kind, 'Корректировки' if item['kind'] == 'adjustment' else item['category_name'], item['category_id'] if item['kind'] != 'adjustment' else None)
            source = other if kind == 'transfer' and positive else account
            target = account if kind == 'transfer' and positive else other
            values = operation_values(session, OperationInput(kind=kind, occurred_on=item['date'], account_id=source.id,
                destination_account_id=target.id if target else None, category_id=category.id if category else None,
                amount_minor=str(abs(int(item['signed_minor']))), comment=(item['description'] + (' · ' + item['extra'] if item['extra'] else ''))[:1000]))
            transaction = Transaction(user_id=uid, source='import', **values)
            if item['kind'] == 'adjustment':
                transaction.adjustment_type = item['adjustment_type'] or 'return_funds'
                if item['related_id']:
                    related = owned(session, Transaction, UUID(item['related_id']))
                    movement = signed_movement(related, account.id)
                    if movement * int(item['signed_minor']) >= 0 or related.occurred_on > date.fromisoformat(item['date']):
                        fail('IMPORT_ADJUSTMENT', 'Связанная операция должна быть более ранним противоположным движением по этому счёту.', 422)
                    transaction.related_transaction_id = related.id
                else:
                    adjustments.append((transaction, item))
            validate_adjustment(session, transaction)
            session.add(transaction); session.flush()
            created.append(str(transaction.id))
            # Private, append-only tenant audit preserves the original bank wording
            # even if the user later edits the transaction comment or category.
            audit(session, uid, transaction, 'imported', {'batch': str(batch.id), 'bank_type': item['bank_type'],
                'original_description': item['description'], 'extra': item['extra'], 'signed_minor': item['signed_minor'],
                'fingerprint': item['fingerprint'], 'ordinal': item['ordinal']})
            remember(session, uid, item, category, other)
        references.append(str(transaction.id))
        session.add(ImportMovement(user_id=uid, bank_digest=batch.bank_digest, fingerprint=item['fingerprint'], ordinal=item['ordinal'], batch_id=batch.id, transaction_id=transaction.id))
    # Exact, unambiguous original merchant + opposite amount. Never guess by a partial name.
    session.flush()
    for transaction, item in adjustments:
        originals = [o for o in session.scalars(select(Transaction).where(Transaction.deleted_at.is_(None), Transaction.adjustment_type.is_(None), Transaction.kind == 'expense', Transaction.occurred_on <= transaction.occurred_on))
                     if signed_movement(o, account.id) == -int(item['signed_minor']) and normalize((o.comment or '').split(' · ')[0]) == normalize(item['description'])]
        if len(originals) == 1:
            original = originals[0]
            returned = sum(o.destination_amount_minor for o in session.scalars(select(Transaction).where(
                Transaction.related_transaction_id == original.id, Transaction.deleted_at.is_(None),
                Transaction.adjustment_type.in_(['refund', 'reversal', 'return_funds']))))
            # A second full refund is ambiguous, not another automatic reduction.
            if transaction.adjustment_type == 'fx' or returned + transaction.destination_amount_minor <= original.source_amount_minor:
                transaction.related_transaction_id = original.id
                validate_adjustment(session, transaction)
                session.flush()
    if not session.scalar(select(BankBinding).where(BankBinding.bank_digest == batch.bank_digest)):
        session.add(BankBinding(user_id=uid, bank_digest=batch.bank_digest, account_id=account.id, last_four=batch.payload['last_four']))
    batch.account_id, batch.status = account.id, 'committed'
    batch.result = dict(found=preview['found'], added=len(created), duplicates=preview['duplicates'], skipped=skipped,
                        matched=len(references) - len(created) - preview['duplicates'], created=created, references=references,
                        baseline=baseline, account_version=account.version, difference_minor=preview['difference_minor'])
    batch.payload = {key: value for key, value in batch.payload.items() if key != 'rows'}
    session.flush(); audit(session, uid, batch, 'committed', {'added': len(created), 'skipped': skipped})
    if body.ready_only:
        response = {**batch.result, 'batch_id': str(batch.id), 'remaining': preview['review'],
                    'complete': preview['review'] == 0, 'preliminary': preview['preliminary']}
        source_batch.account_id = account.id
        source_batch.result = {'request_key': request_key, 'response': response}
        session.flush()
        return response
    return batch.result


@router.delete('/{identifier}/preview')
def cancel(identifier: UUID, auth=Depends(finance_session)):
    session, _ = auth
    batch = draft(session, identifier); batch.status, batch.payload = 'cancelled', {}
    return {'ok': True}


@router.get('')
def history(auth=Depends(finance_session)):
    session, _ = auth
    return [dict(id=str(row.id), status=row.status, created_at=row.created_at.isoformat(), account_id=str(row.account_id) if row.account_id else None,
                 statement={k: v for k, v in row.payload.items() if k != 'rows'}, result={k: v for k, v in row.result.items() if k in ('found', 'added', 'duplicates', 'skipped', 'matched', 'difference_minor')})
            for row in session.scalars(select(ImportBatch).where(ImportBatch.status.in_(['committed', 'undone'])).order_by(ImportBatch.created_at.desc()).limit(100))]


@router.post('/{identifier}/undo')
def undo(identifier: UUID, auth=Depends(finance_session)):
    session, uid = auth
    batch = owned(session, ImportBatch, identifier)
    if batch.status == 'undone': return {'ok': True}
    if batch.status != 'committed': fail('IMPORT_STATUS', 'Отменить можно только сохранённый импорт.')
    created = set(batch.result['created'])
    # A subsequent import may depend on these exact movements (including the other bank side).
    others = session.scalars(select(ImportBatch).where(ImportBatch.status == 'committed', ImportBatch.id != batch.id))
    if any(created.intersection(row.result.get('references', [])) for row in others):
        fail('IMPORT_DEPENDENCY', 'На операции ссылается другой импорт. Сначала отмените зависимый импорт.')
    rows = [owned(session, Transaction, UUID(identifier)) for identifier in created]
    for row in rows:
        if row.version != 1: fail('IMPORT_EDITED', 'Операции импорта были изменены. Автоматическая отмена остановлена.')
        payment_guard(session, row.id)
        if session.scalar(select(Transaction.id).where(Transaction.related_transaction_id == row.id, Transaction.deleted_at.is_(None), Transaction.id.not_in([UUID(i) for i in created]))):
            fail('IMPORT_DEPENDENCY', 'Операция связана с последующей корректировкой.')
    baseline = batch.result.get('baseline')
    account = owned(session, Account, batch.account_id)
    if baseline:
        if account.version != batch.result['account_version']: fail('IMPORT_EDITED', 'Начальный остаток счёта изменён после импорта.')
        if session.scalar(select(Transaction.id).where(Transaction.deleted_at.is_(None), Transaction.occurred_on < date.fromisoformat(baseline['date']),
                Transaction.id.not_in([UUID(i) for i in created]),
                (Transaction.source_account_id == account.id) | (Transaction.destination_account_id == account.id)).limit(1)):
            fail('IMPORT_BASELINE', 'После импорта добавлены более ранние операции. Сначала согласуйте начало учёта.')
    for row in rows:
        row.deleted_at = now(); touch(row); audit(session, uid, row, 'import_undone', {'batch': str(batch.id)})
    session.flush()
    session.execute(delete(ImportMovement).where(ImportMovement.batch_id == batch.id))
    if baseline:
        account.opening_date, account.opening_balance_minor = date.fromisoformat(baseline['date']), int(baseline['amount']); touch(account)
    batch.status = 'undone'; session.flush(); audit(session, uid, batch, 'undone', {})
    return {'ok': True}


@router.get('/rules')
def rules_list(auth=Depends(finance_session)):
    session, _ = auth
    return [dict(id=str(r.id), original=r.original, rule_type=r.rule_type, category_id=str(r.category_id) if r.category_id else None,
                 account_id=str(r.account_id) if r.account_id else None, version=r.version) for r in session.scalars(select(ImportRule).order_by(ImportRule.created_at))]


@router.put('/rules/{identifier}')
def edit_rule(identifier: UUID, body: RuleInput, auth=Depends(finance_session)):
    session, uid = auth
    rule = owned(session, ImportRule, identifier); version(rule, body.expected_version)
    if rule.rule_type == 'category':
        if not body.category_id: fail('IMPORT_RULE', 'Выберите категорию.', 422)
        category = owned(session, Category, body.category_id)
        if category.archived_at: fail('IMPORT_RULE', 'Категория в архиве.', 422)
        rule.category_id, rule.category_kind = category.id, category.kind
    else:
        if not body.account_id: fail('IMPORT_RULE', 'Выберите счёт.', 422)
        account = owned(session, Account, body.account_id)
        if account.currency != 'KZT' or account.archived_at: fail('IMPORT_RULE', 'Нужен активный счёт KZT.', 422)
        rule.account_id = account.id
    touch(rule); audit(session, uid, rule, 'updated', {})
    return {'ok': True}


@router.delete('/rules/{identifier}')
def delete_rule(identifier: UUID, body: RuleInput, auth=Depends(finance_session)):
    session, uid = auth
    rule = owned(session, ImportRule, identifier); version(rule, body.expected_version)
    audit(session, uid, rule, 'deleted', {}); session.delete(rule)
    return {'ok': True}
