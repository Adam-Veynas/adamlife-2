# AdamLife API — авторизация и финансовое ядро

Отдельный FastAPI-проект рядом с `adam_life_web`. React подключён к API авторизации и финансов;
дизайн Obsidian Graphite сохранён. Старые SwiftUI/Flutter клиенты не изменены.
Нужны Python **3.12+** и PostgreSQL **16+**.
Никаких Docker, Redis, аккаунтов хостинга или глобальных npm-пакетов не требуется.

## Что есть

- FastAPI/Uvicorn; синхронный SQLAlchemy 2 и psycopg 3; Alembic.
- Пять PostgreSQL-миграций: базовые сущности, tenant/opening safeguards, авторизация, депозитный тип счёта и его параметры.
- Параметры депозитов: разновидность, годовая ставка, даты открытия/окончания. Миграция `0005_deposit`.
- Пользователи, валюты, счета, категории, операции, расписания/экземпляры платежей,
  аудит, заготовка хранения ключей идемпотентности. Платежи пока представлены только схемой.
- Финансовый CRUD: счета, категории, доходы, расходы, переводы; реальные балансы по валютам.
  При первом входе создаются только стандартные категории пользователя, без счетов и демо-операций.
- Google OIDC code flow, state/nonce/PKCE, проверка ID token, серверные cookie-сессии,
  регистрация по sub, /auth/me и logout. FORCE RLS сохранён.
- Env-конфигурация, закрытые по умолчанию настройки production, ограниченный пул/таймауты,
  CORS по списку точных origin, проверка Host, request ID, безопасные JSON-ошибки.

Решения по валютам, начальным остаткам, импорту и ранней проверке Google на iPhone:
[docs/decisions.md](docs/decisions.md).

## Авторизация

Локальный frontend: **http://localhost:5173/**. Сначала start-api.cmd, затем
adam_life_web/start-adamlife.cmd. Вход Google включится после настройки OAuth client
в Google Console и ввода ID/secret через **configure-google.cmd**.
Без ключей доступна честно обозначенная демонстрация, не фиктивный вход.

Полная схема, API, минимальные действия владельца, настройки HTTPS/Vercel и checklist
физического iPhone: [docs/authentication.md](docs/authentication.md).
Автоматические проверки не заменяют реальный вход Google на HTTPS/iPhone.

Подготовка тестового Render/Vercel размещения и текущий блокер доступа:
[docs/staging.md](docs/staging.md). Конфигурации ещё не применены к облаку.

## Структура

```text
adam_life_api/
  app/                 # config, db, models, auth, auth_models, google_oidc, finance, errors, main
  migrations/          # env.py, template, versions/0001–0005
  scripts/             # ручная настройка выделенной локальной БД и runtime-прав
  tests/               # HTTP/config/schema + opt-in настоящий PostgreSQL
  docs/decisions.md
  .env.example
  alembic.ini
  requirements.txt     # зафиксированные runtime-зависимости
  requirements-dev.txt # + pytest/httpx
  pyproject.toml
  start-api.cmd
```

## Быстрый запуск без базы (только liveness/docs)

В терминале из этой папки, на обычной установленной версии Python:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload --no-access-log
```

После установки окружения также можно открыть `start-api.cmd` двойным нажатием.
На Mac/Linux команды аналогичны, но `python3 -m venv .venv` и `.venv/bin/python`.
В текущей рабочей Windows-среде окружение уже подготовлено с доступным bundled Python;
его не нужно копировать на другой компьютер — `.venv` всегда создаётся заново.

- [Liveness](http://127.0.0.1:8000/health): 200 даже без БД.
- [Readiness](http://127.0.0.1:8000/health/ready): 200 только при доступной БД, актуальной схеме
  и непривилегированной runtime-роли. Иначе 503 в едином формате — это не «готовая БД».
- [Документация](http://127.0.0.1:8000/docs): доступна только не в production.

Приложение не создаёт таблицы при запуске и не запускает миграции автоматически.

## Автоматизированное локальное окружение Windows

Проверено 27 октября 2026: существующий локальный кластер работает, обе базы настроены,
миграции актуальны, **137 тестов проходят без пропусков**, `/health/ready` возвращает 200.
Подробности и ограничения проверки — [docs/verification.md](docs/verification.md).

Добавлена установка PostgreSQL **16.15** внутри `.local/pgsql` из официального ZIP EDB.
Архив проверяется SHA-256 с сервера поставщика; извлекаются только `bin/lib/share`, без
pgAdmin/StackBuilder. Не нужны Docker, системная служба, изменение PATH/реестра/брандмауэра
или администратор. Установка не обращается к другим PostgreSQL-кластерам на компьютере.

Для первой настройки откройте **`setup-local.cmd`**. Скрипт создаст новый локальный кластер,
две базы `adamlife` и `adamlife_test`, разные роли/пароли, локальную `.env`, применит миграции,
выдаст минимальные права API и запустит тесты. Если среда автоматизации Windows задерживает
запуск дочерних процессов initdb, откройте этот файл обычным двойным нажатием в Проводнике.
Никакие команды и пароли вручную вводить не нужно.
Вывод каждого запуска сохраняется отдельно в `.local/setup-<дата>-<id>.log` и одновременно
показывается в окне. Эти локальные журналы не включаются в Git.
Повторный запуск использует уже созданный кластер. Доступность проверяется SQL-подключением
и совпадением каталога данных, поскольку `pg_ctl status` из Windows sandbox может не видеть
процесс, запущенный через Проводник. Вывод pg_ctl сохраняется в `.local/pg-control-*.log`,
чтобы унаследованные фоновым сервером pipe-дескрипторы не задерживали скрипт настройки.

- PostgreSQL: **127.0.0.1:55432**, только loopback, SCRAM-SHA-256; не доступен из Wi-Fi.
- Backend: **127.0.0.1:8000**; запустить `start-api.cmd`, он сначала поднимет локальную БД.
- Отдельный запуск/остановка БД: `start-database.cmd` / `stop-database.cmd`.
- Полный набор проверок с настоящим PostgreSQL: `test-local.cmd`.
- После перезагрузки достаточно `start-api.cmd`; системный автозапуск не добавляется.

Пароли генерируются криптографически и остаются в `.local/local-settings.json` и `.env`.
Оба пути исключены из Git. Не публикуйте эти файлы/каталог `.local`, не отправляйте их в чат
и не включайте в архив исходного кода. Они предназначены только для локальной разработки.
Права/секреты production настраиваются отдельно. Данные сохраняются в `.local/pgdata` между
запусками; не удаляйте эту папку. Остановка PostgreSQL не удаляет данные.

Менеджер `scripts/local_env.py` проверяет владельца кластера и занятость порта, не перезаписывает
чужую `.env`, не удаляет базы/роли и не принимает существующий неизвестный каталог данных.
Незавершённые первые попытки инициализации могут быть сохранены в `.local/pgdata-incomplete-*`;
это диагностические копии без пользовательских данных, не рабочая база.

В тестах используются две роли: владелец миграций без SUPERUSER/BYPASSRLS и отдельная
runtime-роль без владения таблицами. Проверяется также откат контекста RLS и аудита при ошибке.
Только созданные фикстуры пустой `adamlife_test` удаляются downgrade в конце тестов.
База `adamlife` при этом не очищается.

## Если PostgreSQL ещё не установлен

Он необходим для реального хранения и online-проверки миграций. Текущее локальное
окружение уже работает; следующий вариант нужен только для другого компьютера:

1. Установите PostgreSQL 16+ с [официальной страницы Windows](https://www.postgresql.org/download/windows/).
   Достаточно самого сервера и SQL Shell/psql; Stack Builder и дополнительные расширения не нужны.
   Сохраните заданный пароль администратора локально, не отправляйте его в чат.
2. Откройте установленный **SQL Shell (psql)**, подключитесь локально администратором `postgres`.
   Для нового проекта выполните `scripts/bootstrap-local.sql` через `\i 'C:/полный/путь/к/файлу.sql'`.
   Не запускайте скрипт повторно на уже существующей БД с данными.
3. В том же SQL Shell задайте разные пароли интерактивно:

   ```text
   \password adamlife_migrator
   \password adamlife_app
   ```

4. Скопируйте `.env.example` в `.env`. Замените `CHANGE_ME` в двух URL на соответствующие
   пароли. Спецсимволы в URL-пароле необходимо percent-encode. `.env` исключён из Git.
5. Из папки API примените миграции:

   ```powershell
   .\.venv\Scripts\python.exe -m alembic upgrade head
   .\.venv\Scripts\python.exe -m alembic current
   .\.venv\Scripts\python.exe -m alembic check
   ```

6. Переподключитесь в SQL Shell к БД `adamlife` под `adamlife_migrator`:
   `\connect adamlife adamlife_migrator localhost 5432`, затем выполните `scripts/grant-runtime.sql`
   через `\i`. Это выдаёт runtime-роли только нужные права, без ownership и обхода RLS.
7. Запустите backend и откройте `/health/ready`: должен быть ответ 200 `ready`.

Если БД уже есть, не создавайте её повторно: используйте выделенную пустую базу и согласованные
роли. Frontend localStorage не переносится. Существующие пользовательские БД не очищаются.

## Проверки без PostgreSQL

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m alembic heads
.\.venv\Scripts\python.exe -m alembic upgrade head --sql
.\.venv\Scripts\python.exe -m alembic downgrade head:base --sql
.\.venv\Scripts\python.exe -m pip check
```

`--sql` только генерирует PostgreSQL SQL; это **не доказательство применения** к серверу.
Тесты проверяют конфигурацию/ошибки/CORS/таймауты, цепочку миграций, DDL, ключи и ограничения.
Тесты с маркером `postgres` явно пропускаются, если `TEST_DATABASE_URL` не задан.
Не подменяем PostgreSQL SQLite: она не проверяет RLS, PL/pgSQL или поведение psycopg.

## Полные проверки на отдельной тестовой БД

Только для отдельной **пустой** базы `adamlife_test`. Создайте её владельцем обычную выделенную
роль без SUPERUSER/BYPASSRLS. Эта роль должна иметь права создания объектов в своей БД.
Не используйте `postgres` как логин тестов: он обходит RLS и делает проверку недостоверной.

В PowerShell установите `TEST_DATABASE_URL` на URL этой базы (не боевой!) и:

```powershell
$env:ADAMLIFE_ALLOW_TEST_DATABASE_RESET = "1"
.\.venv\Scripts\python.exe -m pytest -q
```

Тесты откажутся работать с именем без `_test`, с привилегированным логином и непустой схемой.
Они выполняют upgrade, сравнение реальной схемы с ORM, проверку RLS двух владельцев/пула,
точности BIGINT, валют/FK, начальной границы/версии/аудита, связей платежей и downgrade.
В конце созданные **только в этой тестовой БД** таблицы и фикстуры удаляются откатом миграции;
может остаться пустая `alembic_version`. Не запускайте downgrade на реальной базе с данными.

## Формат ошибок

```json
{"error":{"code":"DATABASE_NOT_READY","message":"Database configuration, schema or runtime role is not ready","details":[],"request_id":"<uuid>"}}
```

Такой же request ID приходит в `X-Request-ID`. Для ошибок валидации details содержит только
место/тип ошибки, не введённые данные. Ответы не раскрывают SQL, DSN, пароли и traceback.
Коды: `VALIDATION_ERROR` 422, `DATA_CONFLICT` 409, `DATABASE_UNAVAILABLE`/`DATABASE_NOT_READY` 503,
`INTERNAL_ERROR` 500, `HTTP_404`, `HTTP_405`, `INVALID_HOST`, `CORS_REJECTED`.
Серверные сообщения логируют ID и класс сбоя, не финансовые значения/текст исключения.

## Будущее размещение

Backend — отдельный Python web service, frontend остаётся на Vercel. Пример настроек сервиса:

- Root directory: `adam_life_api`.
- Build: `python -m pip install -r requirements.txt`.
- Migration job: `python -m alembic upgrade head` с **отдельно** доступным `MIGRATION_DATABASE_URL`.
- Start: `python -m uvicorn app.main:app --host 0.0.0.0 --port $PORT --no-access-log` (Linux shell, PORT задаёт хостинг).
- Health check сервиса: `/health/ready`.
- Env API: `APP_ENV=production`, runtime `DATABASE_URL` с TLS, JSON-массивы точных HTTPS
  `CORS_ORIGINS` и публичных `TRUSTED_HOSTS` (без портов). Предпочтительно `sslmode=verify-full`
  с доверенным сертификатом; `require` шифрует, но не даёт полноценной проверки имени сервера.
- TLS для HTTP завершает доверенный reverse proxy хостинга. Proxy headers принимать только от
  его известных адресов; не открывать доверие ко всем прокси без сетевого ограничения.
- Миграционный пароль не передавать API-процессу в production. Отдельно выполнить grants
  с фактическими именами ролей хостинга. Не запускать API от владельца/администратора БД.
- Access log отключён: полный URL будущего OAuth callback может содержать секретный code.
  Логи reverse proxy также должны скрывать query/body/cookies; включать только безопасные поля.
- До хранения настоящих данных нужны проверка OAuth/CSRF, тест изоляции на deployment,
  резервные копии PostgreSQL и проверка восстановления. Этап 1 сам по себе ещё не production-релиз.

Здесь не созданы платные сервисы, контейнеры, CI-аккаунты, реальные OAuth credentials,
PDF-хранилище или аналитика. Frontend авторизации подключён. Реальный Google-вход
и HTTPS на физическом iPhone остаются внешней приёмочной проверкой.


### Накопления (локальный этап 2)

Текущая схема: `0006_savings` (после неопубликованной `0005_deposit`). После обновления выполнить `python -m alembic upgrade head` и `scripts/grant-runtime.sql` от миграционной роли. В локальном окружении это уже выполнено. Новые API находятся под `/finance`: `savings`, `goals`, `goals/{id}/status`, `deposit-plans/{id}`. Цели и планы доступны только авторизованному пользователю; демоданные не переносятся. Правила распределений, архива и месячной истории описаны в `docs/decisions.md`, результаты — в `docs/verification.md`.
