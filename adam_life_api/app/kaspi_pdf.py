"""Strict text-only Kaspi Gold statement parser. No network, OCR or PDF persistence."""
from collections import Counter
from datetime import datetime
from decimal import Decimal
from hashlib import sha256
from io import BytesIO
import re
import unicodedata

MAX_BYTES = 5 * 1024 * 1024
MAX_ROWS = 5000
DATE = r"\d{2}\.\d{2}\.(?:\d{4}|\d{2})"
AMOUNT = r"[+−-]?\s*\d[\d \xa0\u202f]*,\d{2}"
ROW = re.compile(rf"^\s*({DATE})\s+({AMOUNT})\s*₸\s+(.+)$")
TYPES = re.compile(r"^(Перевод на свои счета|Перевод на свой сч[её]т|Перевод на свой|Покупка|Пополнение|Перевод|Разное|Возврат|Отмена|Курсовая разница|Снятие)(?:\s{2,}|$)(.*)$")


class StatementError(ValueError):
    pass


def normalize(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def minor(value):
    return int(Decimal(re.sub(r"\s", "", value).replace("−", "-").replace(",", ".")) * 100)


def date_value(value):
    return datetime.strptime(value, "%d.%m.%Y" if len(value) == 10 else "%d.%m.%y").date().isoformat()


def parse_texts(pages):
    start = next((i for i, page in enumerate(pages) if re.search(r"(?m)^\s*ВЫПИСКА\s*$", page) and "Kaspi Gold" in page), None)
    if start is None:
        raise StatementError("Не найден раздел выписки Kaspi Gold. Нужен текстовый PDF банка, не скан.")
    header = pages[start]
    period = re.search(rf"по Kaspi Gold за период с ({DATE}) по ({DATE})", header)
    iban = re.search(r"Номер счета:\s*(KZ[A-Z0-9]{18})", header)
    card = re.search(r"Номер карты:\s*\*(\d{4})", header)
    if not period or not iban or not card or not re.search(r"Валюта счета:\s*(теңге|тенге|KZT)", header):
        raise StatementError("Не удалось надёжно определить счёт, период или валюту KZT.")
    begin, end = map(date_value, period.groups())
    balances = {}
    for match in re.finditer(rf"Доступно на ({DATE}):?\s+({AMOUNT})\s*₸", header):
        key, value = date_value(match[1]), minor(match[2])
        if key in balances and balances[key] != value:
            raise StatementError("Остатки в разделе выписки неоднозначны.")
        balances[key] = value
    if begin > end or begin not in balances or end not in balances:
        raise StatementError("В выписке отсутствуют начальный или конечный остаток.")
    rows, current = [], None
    for page in pages[start:]:
        in_table = False
        for line in page.splitlines():
            match = ROW.match(line)
            if not match and re.match(rf'^\s*{DATE}\s', line):
                raise StatementError('Строка с датой не распознана. Импорт остановлен.')
            if match:
                in_table = True
                typed = TYPES.match(match[3])
                if not typed:
                    raise StatementError("Обнаружен неподдерживаемый тип банковской операции.")
                bank_type, description = typed.groups()
                current = dict(date=date_value(match[1]), signed_minor=str(minor(match[2])), bank_type=bank_type,
                               description=description.strip(), extra="")
                if not begin <= current['date'] <= end or int(current['signed_minor']) == 0:
                    raise StatementError("Дата или сумма операции не соответствует выписке.")
                rows.append(current)
                if len(rows) > MAX_ROWS:
                    raise StatementError("Слишком много операций: загрузите выписку за меньший период.")
            elif in_table and line.strip():
                value = line.strip()
                if value.startswith(("- Сумма заблокирована", "Раздел «", "счета»")):
                    in_table = False
                    continue
                if re.match(rf"^\s*{DATE}\b", line):
                    raise StatementError("Строка операции не распознана. Сохранение остановлено.")
                if value in ("счет", "счёт", "счета") and current['bank_type'].startswith("Перевод на свой"):
                    current['bank_type'] = "Перевод на свой счёт"
                elif len(line) - len(line.lstrip()) >= 15:
                    current['extra'] = (current['extra'] + " " + value).strip()
    if not rows or balances[begin] + sum(int(row['signed_minor']) for row in rows) != balances[end]:
        raise StatementError("Сумма операций не совпала с остатками выписки. Импорт остановлен: нужен полный текстовый PDF.")
    counts = Counter()
    for index, row in enumerate(rows):
        # Rank multiplicities, never collapse identical purchases within a statement.
        source = "|".join([row['date'], row['signed_minor'], normalize(row['bank_type']), normalize(row['description']), normalize(row['extra'])])
        row['fingerprint'] = sha256(source.encode()).hexdigest()
        counts[row['fingerprint']] += 1
        row['ordinal'] = counts[row['fingerprint']]
        row['index'] = index
    return dict(bank="kaspi", product="Kaspi Gold", account_digest=sha256(iban[1].encode()).hexdigest(), last_four=card[1],
                currency="KZT", start=begin, end=end, opening_minor=str(balances[begin]), closing_minor=str(balances[end]), rows=rows)


def parse_pdf(content):
    from pypdf import PdfReader
    if not content.startswith(b"%PDF-") or not 10 <= len(content) <= MAX_BYTES:
        raise StatementError("Выберите PDF размером не более 5 МБ.")
    reader = PdfReader(BytesIO(content), strict=True)
    if reader.is_encrypted or not 1 <= len(reader.pages) <= 40:
        raise StatementError("Нужен незашифрованный PDF не более 40 страниц.")
    pages = []
    for page in reader.pages:
        value = page.extract_text(extraction_mode="layout")
        if len(value) > 500000:
            raise StatementError("Слишком сложный PDF. Сформируйте более короткую выписку.")
        pages.append(value)
    return parse_texts(pages)
