import os
from pathlib import Path
from hashlib import sha256

import pytest

from app.kaspi_pdf import StatementError, normalize, parse_pdf, parse_texts
from app.kaspi_import import suggest


def text_statement(lines, opening='100,00', closing='80,00'):
    return f'''ВЫПИСКА
по Kaspi Gold за период с 01.10.26 по 10.11.26
Номер счета: KZ123456789012345678
Номер карты: *1111
Валюта счета: теңге
Доступно на 01.10.26 + {opening} ₸
Доступно на 10.11.26 + {closing} ₸
Дата    Сумма    Операция    Детали
{lines}'''


def test_statement_section_not_cover_and_identical_multiplicity():
    text = text_statement('  01.10.26  - 10,00 ₸  Покупка  ИП ТЕСТ\n  01.10.26  - 10,00 ₸  Покупка  ИП ТЕСТ')
    value = parse_texts(['Справка. Остаток 999 999,00 ₸', text])
    assert value['opening_minor'] == '10000' and value['closing_minor'] == '8000'
    assert [r['ordinal'] for r in value['rows']] == [1, 2]
    assert value['rows'][0]['fingerprint'] == value['rows'][1]['fingerprint']
    assert 'KZ123456789012345678' not in str(value)


def test_multiline_cyrillic_and_exact_minor_units():
    value = parse_texts([text_statement('  01.10.26  - 10,01 ₸  Покупка  Қазақ дүкені', closing='90,41'),
                        '  02.10.26  + 0,42 ₸  Покупка  Қазақ дүкені\n                         курсовая разница'])
    assert [r['signed_minor'] for r in value['rows']] == ['-1001', '42']
    assert value['rows'][1]['extra'] == 'курсовая разница'


@pytest.mark.parametrize('pages', [['not a statement'], [text_statement('  01.10.26  - 9,00 ₸  Покупка  Тест')], [text_statement('  01.10.26  - 20,00 ₸  Незнакомое  Тест')], [text_statement('  01.10.26  - 20,00 USD  Покупка  Тест')]])
def test_unreliable_structure_or_balance_fails_closed(pages):
    with pytest.raises(StatementError): parse_texts(pages)


def test_rejects_fake_pdf():
    with pytest.raises(StatementError): parse_pdf(b'<html>not pdf</html>')


def test_safe_name_normalization_and_suggestions():
    assert normalize(' ИП   ҚАЗАҚ ') == normalize('ип қазақ')
    assert normalize('ИП ТЕСТ') != normalize('ИП ТЕСТ 2')
    base = dict(description='ИП Неизвестный', extra='', bank_type='Покупка', signed_minor='-100')
    assert suggest(base, [], [])['requires_review']
    assert suggest({**base, 'description': 'Гелиос'}, [], [])['category_name'] == 'Топливо'
    assert suggest({**base, 'description': 'OPENAI CHATGPT SUBSCR'}, [], [])['category_name'] == 'Подписки'
    assert suggest({**base, 'bank_type': 'Перевод', 'description': 'Получатель'}, [], [])['category_name'] == 'Переводы людям'
    assert suggest({**base, 'description': 'Комиссия за перевод'}, [], [])['category_name'] == 'Банковские комиссии'
    assert suggest({**base, 'signed_minor': '42', 'extra': 'курсовая разница'}, [], [])['kind'] == 'adjustment'
    assert suggest({**base, 'signed_minor': '2000000', 'bank_type': 'Пополнение', 'description': 'Отмена перевода'}, [], [])['adjustment_type'] == 'reversal'


def test_real_statement_local_only():
    path = os.environ.get('KASPI_SAMPLE_PDF')
    if not path: pytest.skip('Private sample path is supplied only for a local verification')
    content = Path(path).read_bytes()
    value = parse_pdf(content)
    assert len(value['rows']) == 211
    assert int(value['opening_minor']) + sum(int(r['signed_minor']) for r in value['rows']) == int(value['closing_minor'])
    assert sha256(content).digest() == sha256(Path(path).read_bytes()).digest()
