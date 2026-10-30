# Проверки AdamLife API

## Подготовка HTTPS staging — 27 октября 2026

- Проверены существующие callback, host-only Secure/HttpOnly/SameSite=Lax cookies,
  state/nonce/PKCE, exact Origin/CSRF, CORS и standalone manifest. Логика не переписана.
- Добавлены deployment/render.database.yaml и render.service.yaml: только Free,
  раздельные этапы, PostgreSQL 16, облачная БД закрыта для внешних IP по умолчанию.
  API не получает owner connection string, нет автоматических миграций при старте.
  Blueprint подготовлен по документации; cloud/API validation не выполнена без Render.
- Добавлены .vercelignore и env/.vercel exclusions frontend. Реальные env не изменены.
- Vercel CLI whoami подтвердил adam-veynas; project ls завершился ошибкой CLI Windows.
  Список проектов не подтверждён; старый Flutter deployment не изменён.
- Render в браузере требует Sign In; подключение Render к чату ещё отсутствует.
  Подключение предложено пользователю. Облачные ресурсы/репозиторий не создавались.
- Регрессия: **137 backend passed in 20.32s, 132 frontend passed, 0 skipped**.
  Реальная локальная PostgreSQL 16.15/0003_auth; runtime без SUPERUSER/BYPASSRLS.
  TypeScript/Vite production build успешно.
- Локальный backend /health/ready **200**; proxy /api/auth/config:
  google_enabled=false. Реальные Google credentials отсутствуют.
- **Публичного HTTPS deployment ещё нет.** Миграции облачной БД, настоящий Google-вход,
  изоляция двух реальных Google пользователей и физический iPhone пока не проверены.
- Следующий блокирующий шаг — подключить Render. Платные ресурсы не создавались,
  локальная БД не публиковалась, секреты/финансовые данные не загружались.

План продолжения и безопасные настройки: [staging.md](staging.md).

## Авторизация — финальная проверка 27 октября 2026

**Код готов к приёмочным испытаниям; полная внешняя приёмка ещё не завершена.**
Настоящие credentials Google и публичный HTTPS не настроены. Поэтому реальный вход
в Google, cookies на выбранном production proxy и возврат Safari/установленной PWA
на физическом iPhone НЕ подтверждены. Это не скрытые пропуски pytest: эти отдельные
ручные приёмочные сценарии требуют внешней настройки.

### Фактически выполнено

- При возобновлении найден работающий PostgreSQL 16.15, уже применённая 0003_auth
  и существующая реализация backend/frontend. Повторного initdb/скачивания не было.
- Исправлены побочный эффект initializer React StrictMode (исчезавшая ошибка callback),
  отказ при снятой конфигурации Google и обработка не-ASCII nonce/CSRF без 500.
- Добавлен configure-google.cmd: скрытый ввод секрета только локально, сохранение
  существующих DB-настроек; .env.example дополнен несекретными примерами.
- Alembic upgrade/current: **0003_auth (head)**; check:
  **No new upgrade operations detected**. Старая финансовая схема сохранена.
- Полный backend: **137 passed, 0 skipped in 21.68s** через
  `.venv\Scripts\python.exe scripts/local_env.py test`.
  Из них 42 сценария в test_auth_postgres.py проверяют авторизацию на реальной
  отдельной PostgreSQL; 5 проверяют помощник настройки; прежние 90 проверок сохранены.
- В PostgreSQL проверены регистрация/repeat login по sub, несовпадающие аккаунты
  с одинаковым email, смена профиля, secure cookie flags/хеши, state/nonce/PKCE,
  неверные/недостающие claims и поддельная подпись, single-use/parallel callback,
  CSRF/Origin, истечение/отзыв, logout, независимые пользователи/сессии, spoofed
  user_id, RLS/пул, параллельная регистрация, восстановление сессии новым экземпляром
  backend. Только внешний HTTP Google подменён; RSA-подписи и JWT-проверки настоящие.
- Прежние PostgreSQL-тесты RLS, FK, начальных остатков, валют/BIGINT, триггеров,
  аудита, rollback, миграций upgrade/downgrade продолжают проходить.
- `pip check`: No broken requirements found; compileall app/migrations/scripts/tests
  успешно. Новых frontend-зависимостей нет.
- Frontend: `npm run build` (TypeScript + Vite) успешно; `npm test` —
  **132 passed, 0 skipped**, 8 файлов. В том числе 14 auth-тестов: восстановление,
  очистка памяти, logout/CSRF, поздние ответы, сетевые ошибки, cookie transport,
  отсутствие автоматической подмены сессии демонстрацией. Прежние 118 тестов сохранены.
- **Общий автоматический итог: 269 passed, 0 skipped.**

### Локальная сквозная проверка

Перезапущен Uvicorn с актуальным кодом. HTTP через Vite proxy localhost:5173:

| Запрос | Результат |
| --- | --- |
| GET /api/health/ready | 200 ready |
| GET /api/auth/config | 200, google_enabled=false |
| GET /api/auth/me без cookie | 401 AUTH_REQUIRED |
| POST /api/auth/google/start, правильный Origin | 503 GOOGLE_NOT_CONFIGURED |
| POST /api/auth/google/start, чужой Origin | 403 CSRF_REJECTED |
| GET /api/auth/google/callback без flow | 303 на фиксированный frontend с auth_error |

Все перечисленные ответы Cache-Control: no-store. 503 в строке Google start ожидаем:
реальные ключи не подменялись тестовыми и ложный вход не добавлялся.
Runtime роль adamlife_app: superuser=false, bypassrls=false.
Development users/accounts/transactions = **0/0/0**, currencies=3.
Ни development, ни другие пользовательские базы не очищались. Тестовые фикстуры
удаляет штатный rollback миграций только в выделенной adamlife_test.

В браузере проверены: экран Graphite, явный вход/выход из прежнего демо, загрузка
старой Главной, ошибка отмены callback в StrictMode, закрытое состояние при остановке
API и восстановление после его запуска. При viewport 390x844 нет горизонтального
переполнения: document scrollWidth 375 <= innerWidth 390. Это проверка адаптивности,
**не тест физического iPhone**. Реальная авторизованная страница проверяется после Google.

### Что осталось для приёмки

1. Создать Google Web OAuth client/consent screen, зарегистрировать точный localhost
   callback, ввести ID/secret через configure-google.cmd и перезапустить backend.
2. Выполнить настоящий вход/выход Google. Выбрать HTTPS frontend/backend deployment,
   настроить same-origin /api proxy и production env, зарегистрировать HTTPS callback.
3. Пройти checklist Safari + standalone на физическом iPhone, проверить proxy cookies/
   отсутствие кэша/логирования секретов. Перед публичным размещением настроить
   ограничение частоты запросов, мониторинг, backup/restore и retention auth-таблиц.

Подробности: [authentication.md](authentication.md), конфигурационный шаблон
adam_life_web/deployment/vercel.example.json. Публичное размещение не выполнялось.
Google RISC/автоматические события отзыва согласия не реализованы; поддержаны
истечение и серверный отзыв сессий AdamLife. Финансовый CRUD не начинался.

Старые секции ниже — история инфраструктурного этапа, не текущие ограничения.

## Настройка завершена — 27 октября 2026

**Локальное окружение готово к следующему этапу.** PostgreSQL 16.15 работает на
127.0.0.1:55432. Использован кластер `.local/pgdata`, созданный пользователем через
`setup-local.cmd` в Проводнике. Повторного initdb, удаления/пересоздания кластера,
скачивания PostgreSQL или очистки development-базы не выполнялось.

Проверены маркер кластера, аутентификация и совпадение SHOW data_directory с pgdata.
PID сервера при проверке — 4960; журнал содержит `ready to accept connections`,
SQL сообщает время запуска 27.10.2026 06:55:43 UTC (11:55:43 местного времени).
В этой среде pg_ctl status возвращал код 3 при доступном работающем сервере.
Поэтому менеджер теперь проверяет соединение и принадлежность кластера; занятый чужим
сервером порт не приводит к запуску/остановке процессов. Добавлены два regression-теста.

Старый setup-журнал остановился на сообщении Success initdb и не отражал дальнейшее
состояние: фактически сервер уже был запущен, базы и миграции существовали. Возможное
ожидание EOF у pipe, унаследованного фоновым postgres, исключено: вывод pg_ctl теперь
направляется в отдельный `.local/pg-control-*.log`. Добавлены явные сообщения шагов.
Точное внутреннее состояние старого процесса настройки не установлено, он не завершался
принудительно. Новый повторный запуск на существующем кластере завершился с кодом 0.

Подтверждённые результаты:

- Development `adamlife` и отдельная `adamlife_test` существуют с разными owner/runtime-ролями.
- Runtime `adamlife_app`: SUPERUSER=false, BYPASSRLS=false; проверка владения таблицами пройдена.
- Alembic upgrade/current: `0002_tenant_guards (head)`; check: `No new upgrade operations detected`.
- Все **22 ранее пропущенных PostgreSQL-теста выполнены**. Полный итог: **90 passed, 0 skipped**.
  Включены реальные RLS, связи владельцев, BIGINT/валюты, триггеры даты начала/версии/аудита,
  rollback/пул, запрет изменения аудита, ограничения переводов/платежей и upgrade/downgrade.
- Повторный запуск `scripts/setup-local.ps1` полностью прошёл: **90 passed in 2.75s**, exit 0.
  Полный вывод сохранён в `.local/setup-20261027-120835-0cad3e86dfa04325b3eca259bfe18246.log`.
- Настоящий Uvicorn с runtime-подключением: `/health` → **200 ok**, `/health/ready` → **200 ready**.
- Development: users/accounts/transactions = 0/0/0, currencies = 3; демо-данные не переносились.
- После тестов в отдельной тестовой public-схеме осталась только пустая alembic_version;
  development-схема и кластер сохранены.
- pip check и compileall app/migrations/tests/scripts успешны.

Backend оставлен запущенным на http://127.0.0.1:8000. После перезагрузки используется
`start-api.cmd`. Frontend, OAuth и новые функциональные этапы не затрагивались.
Секции ниже — история диагностики, их прежние блокеры больше не описывают текущую готовность.

## Повторная диагностика — 27 октября 2026

Предыдущая настройка не завершилась: на начало проверки отсутствовали рабочая `pgdata`,
маркер успешной инициализации и `.env`. Подключение на 127.0.0.1:55432 не установлено.
Использованы уже скачанные binaries 16.15; повторной загрузки и установки не было.

Повторный initdb доходит до `selecting default max_connections/shared_buffers`, но не
создаёт системные каталоги и завершается по таймауту 120 секунд. Прямой запуск
`postgres --check` (в том числе с эквивалентным CMD quoting и NUL-перенаправлениями)
завершается с кодом 0. Это локализует проблему в запуске проверок из initdb, но не
устанавливает окончательную причину. Доступ к журналу Application Windows из среды
автоматизации отклонён; ошибки PostgreSQL из этого журнала не получены.

Отдельно подтверждена блокировка локальных сокетов в ограниченной среде: Python
останавливался в `socket._fallback_socketpair -> accept` при создании asyncio loop.
После разрешения network проверка socketpair и API-тесты проходят. На задержку initdb
это разрешение не повлияло. Ограничения токенов Windows и защиты системы не отключались.

Фактический повторный прогон: **66 passed, 22 skipped in 2.03s**. Все 22 пропуска —
отсутствующий TEST_DATABASE_URL; интеграционные проверки не выполнены.
`pip check`: No broken requirements found. Компиляция app/migrations/tests/scripts успешна.
Uvicorn запущен для проверки: GET `/health` → **200**, GET `/health/ready` → **503**,
код `DATABASE_NOT_READY`. Проверочный сервер затем остановлен.

Для обычного запуска Windows обновлён `setup-local.cmd`: помощник `scripts/setup-local.ps1`
показывает вывод prepare/test и сохраняет каждую попытку в отдельный `.local/setup-*.log`.
PowerShell-синтаксис проверен парсером; успешный полный запуск скрипта ещё не подтверждён.
Незавершённые каталоги сохранены отдельно без удаления файлов или пользовательских баз.

Следующее действие: открыть `setup-local.cmd` двойным щелчком в Проводнике. После этого
проверить журнал, подключение, миграции, все 88 тестов и HTTP 200 `/health/ready`.
До этих проверок PostgreSQL и готовность к следующему этапу **не подтверждены**.
Frontend, OAuth и финансовая функциональность не изменены.

## История проверки — 23 октября 2026

## Текущее состояние после подготовки локального окружения

Среда: Windows, Python 3.12.14, локальное `.venv` в `adam_life_api`.
Установленные PostgreSQL и Docker не обнаружены в PATH, стандартных каталогах и
доступных записях установленных программ. Существующие службы/базы не изменялись.

В `.local/pgsql` извлечены официальные Windows x64 binaries PostgreSQL **16.15** (EDB),
только bin/lib/share. `postgres.exe --version` успешно возвращает 16.15.
Архив скачан через HTTPS с сайта поставщика и проверен по опубликованному им SHA-256:

```text
43bb45f173a6f08cf1d29a97a6d8deb119e8e8093a24c00d2d1001a0ccaa8281
```

Источники:
[Windows binaries](https://get.enterprisedb.com/postgresql/postgresql-16.15-5-windows-x64-binaries.zip),
[SHA-256](https://get.enterprisedb.com/postgresql/postgresql-16.15-5-windows-x64-binaries.zip.sha256).
Docker, Windows service, PATH/реестр/брандмауэр не устанавливались и не менялись;
повышение прав не запрашивалось. Локальные пароли сгенерированы и не выводились в чат.

**Блокер:** запуск initdb из управляемой среды не проходит автоматические пробы
max_connections/shared_buffers и завершается по таймауту. Самостоятельный postgres --check
работает; успешное создание полноценного кластера этим не подтверждается. Пробовались UTC,
короткие Windows-пути и обычный консольный запуск. Нельзя выдавать эти попытки за готовую БД.
Незавершённые новые каталоги сохранены в `.local/pgdata-incomplete-*`; никаких существовавших
пользовательских баз не удалялось. Для завершения подготовлен обычный Windows-запуск
`setup-local.cmd`; пользователь сообщил о запуске, но подключение пока не подтверждено.

Скрипт предусматривает отдельные development/test БД и роли, SCRAM, loopback 127.0.0.1:55432,
миграции/grants, приватную `.env`, полный прогон и повторяемый запуск после перезагрузки.
Это подготовленная автоматизация, **не подтверждение создания баз**.

Последний прогон в текущей среде: **66 passed, 22 skipped**, без предупреждений.
7 новых unit-тестов проверяют сохранность существующих файлов/данных, повторное использование
секретов, маскирование и разделение URL. В PostgreSQL-набор добавлены 3 проверки реальной
runtime-роли, сброса RLS/аудита при rollback и запрета изменения аудита.
`pip check` и компиляция app/migrations/tests/scripts прошли.

Готовность к следующему этапу: **ещё не подтверждена**. Нужны успешный setup, online-миграции,
полный прогон без skips и HTTP 200 `/health/ready` с работающей БД. Frontend и OAuth не изменялись.

## Результаты предыдущей проверки до установки binaries

## Выполнено

- `python -m pytest -q`: **59 passed, 19 skipped**, без предупреждений.
- Пропущены исключительно настоящие PostgreSQL-тесты из `tests/test_postgres.py`.
  Причина пропуска выводится явно: нет TEST_DATABASE_URL.
- `python -m alembic heads`: единственная вершина `0002_tenant_guards`.
- `python -m alembic upgrade head --sql`: успешная генерация PostgreSQL SQL двух миграций.
- `python -m alembic downgrade head:base --sql`: успешная генерация обратного SQL.
- Сравнение колонок, SQL-типов, defaults, nullable, FK, CHECK, UNIQUE, PK и индексов
  замороженной начальной миграции с ORM-метаданными — успешно, без подключения к БД.
- `python -m pip check`: No broken requirements found.
- `python -m compileall -q app migrations tests`: успешно.
- Запуск настоящего Uvicorn и HTTP-запросы по 127.0.0.1:8000:
  `/health` → 200, `/health/ready` → ожидаемый 503 без БД, неизвестный путь → 404.
  Ошибки — JSON с code/message/details/request_id; X-Request-ID соответствует телу.
  Проверочный сервер после проверки остановлен; для запуска есть `start-api.cmd`.
- Изменений исходных файлов `adam_life_web`, `adam_life_flutter`, `AdamLife`,
  `AdamLife.xcodeproj` в этом этапе нет; проверены также даты изменения существующих файлов.

## Ещё не проверено на настоящем PostgreSQL

Применение и откат миграций, реальное сравнение схемы, исполнение PL/pgSQL-триггеров,
RLS между владельцами/через пул, хранение BIGINT и ограничения связей.
Для этих сценариев подготовлены 22 opt-in теста, но их пропуск — **не успешное прохождение**.
Offline-генерация SQL не доказывает его выполнение на PostgreSQL.

До следующего функционального этапа следует подключить PostgreSQL, применить миграции,
выдать runtime-права, получить 200 от `/health/ready` и прогнать весь набор на отдельной
пустой тестовой БД. Пошаговая настройка и защита тестовой БД описаны в README.

Google OAuth, финансовый CRUD, PDF-импорт, аналитика, подключение frontend и проверка
HTTPS/iPhone намеренно не выполнялись. Ранняя проверка Google на физическом iPhone —
обязательный приёмочный пункт следующего этапа авторизации, не выполненная здесь проверка.
