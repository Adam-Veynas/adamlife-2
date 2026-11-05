# Проверки AdamLife API

## Финансовое ядро — 5 ноября 2026

- Backend: **34 passed, 0 skipped** — только `test_finance_postgres.py` (15),
  `test_migrations.py` и проверка списка API-маршрутов (19 суммарно).
- Финансовые интеграционные проверки используют настоящую локальную PostgreSQL,
  роль без BYPASSRLS, серверные сессии и выделенную `adamlife_test`; авторизация не подменена.
  Проверены CRUD, два пользователя, CSRF, чужие UUID, начальные остатки и аудит,
  архив/безопасное удаление, версии, категории, граница учёта, будущие записи,
  переводы/смена сторон и типа, валюты, точность и чтение после пересоздания соединений.
- Реальные upgrade/downgrade до `0004_finance` и сравнение схемы с ORM — успешно.
  Исправлено удвоение имени CHECK-ограничения Alembic naming convention.
- Frontend: **27 passed, 0 skipped** — `src/finance/finance.test.ts` (12) и
  `src/auth/auth.test.ts` (15). Точность BigInt, фильтры, переводы, HTTP/CSRF,
  отсутствие автодемо, очистка сессии, сохранение формы при фоновой проверке сессии.
- TypeScript `tsc -b` и Vite production build — успешно. Зависимости не добавлялись.
- В локальной development-БД применена миграция `0003_auth → 0004_finance`,
  без удаления данных. `/health/ready` через FastAPI TestClient с реальным lifespan
  и runtime-подключением: **200**. Это проверка приложения, не публичного хостинга.
- Итого точечный набор: **61 passed, 0 skipped**. Полный набор не запускался.
- Настоящий Google-вход ранее подтверждён владельцем; в этом этапе повторно не проверялся.
  Сквозной пользовательский сценарий нового UI на физическом iPhone пока не проверен.
  Сохранение проверено новым подключением к БД, не перезагрузкой компьютера.

### Перед размещением

Нужны подтверждение владельца, публикация изменений frontend/backend и применение
`alembic upgrade head` в облаке с существующей migration-ролью. Новых секретов,
таблиц или runtime-грантов миграция не требует. Миграция, backend и frontend должны
выходить согласованно: readiness проверяет точную ревизию схемы. После выпуска проверить
ready и с iPhone создать счёт/операцию, перезагрузить страницу, проверить остаток и выход.
В этом этапе облачная БД, Render, Vercel и GitHub не изменялись.

Дополнительные поля депозитов отложены по разрешённой границе этапа. Межвалютные переводы,
PDF, расширенная аналитика и платежные функции не реализованы. История пока загружается
целиком; автоматические повторы записи и серверная идемпотентность не включены.

## Диагностика отказа настоящего Google-входа — 4 ноября 2026

- После ввода credentials владельцем и успешного Render deploy в 15:55 (UTC+5)
  пользователь сообщил возврат с auth_error=failed. Application logs за последний
  час содержат startup/deploy, но не причину OAuth-отказа. Причина НЕ установлена:
  существующий callback молча возвращал одинаковый redirect для нескольких ошибок.
- Публичный POST /api/auth/google/start: 200, точный callback
  https://adamlife-2.vercel.app/api/auth/google/callback, PKCE S256, flow cookie
  Secure/HttpOnly/SameSite=Lax/Path=/, без Domain. Cookies/коды/токены не выводились.
- Добавлена только диагностика: фиксированные причины отказа callback; стадия
  обмена кода/проверки ID token, класс исключения, HTTP status и allowlist error
  Google. Текст исключений, response body, claims и request query не логируются.
  Поведение авторизации и проверки безопасности не изменены; это НЕ доказанное
  исправление исходной ошибки, а подготовка следующего воспроизведения.
- tests/test_oauth_diagnostics.py: 11 passed; compileall двух изменённых модулей
  успешен. Полный набор, повторные миграции и финансовые тесты не запускались.
- GitHub main: 866f55f (callback), d53eac8 (provider), a55758d (tests).
  Render deploy dep-dblh28rncjis73drg4i0: Deploy succeeded | Live, 16:05 UTC+5;
  Application startup complete. Диагностика доступна для новой попытки входа.
- Для установления причины нужен новый реальный вход после диагностического деплоя.

## Точечная проверка OAuth — 4 ноября 2026

- Render Environment: APP_ENV=production, FRONTEND_ORIGIN=https://adamlife-2.vercel.app,
  CORS_ORIGINS содержит только этот origin, GOOGLE_REDIRECT_URI точно
  https://adamlife-2.vercel.app/api/auth/google/callback. GOOGLE_CLIENT_ID и
  GOOGLE_CLIENT_SECRET отсутствуют; значения секретов не раскрывались.
- Публичный API: /api/health/ready 200, /api/auth/config 200/google_enabled=false,
  /api/auth/me 401; Google start с чужим Origin 403; CORS preflight своего origin 200
  с точным Access-Control-Allow-Origin. Проверенные ответы имеют no-store.
- Удаляющий session cookie на 401: Secure, HttpOnly, SameSite=Lax, host-only.
  Настоящая login-сессия, Google callback и физический Safari/PWA не проверены.
- Backend: только test_google_configuration.py + test_config_db.py — 28 passed.
  Первый запуск: 22 passed, 6 setup errors из-за недоступной sandbox temp-папки;
  повтор с отдельным --basetemp внутри .local: все 28 прошли, код не менялся.
- Frontend: только src/auth/auth.test.ts — 14 passed; восстановление, logout,
  очистка памяти, гонки пользователей, отсутствие автоматической подмены демо.
- Итого 42 passed, 0 skipped в выбранных наборах. PostgreSQL RLS интеграционные
  тесты не повторялись; актуальная изоляция двух реальных Google-пользователей
  не подтверждена этим прогоном (ранее проверена на синтетических пользователях).
- В существующей вкладке Google Cloud всё ещё незавершённая форма Finish с
  неотмеченным User Data Policy. Нужны согласие владельца, OAuth client и закрытая
  настройка ID/secret в Render. Регистрация redirect в Google ещё не подтверждена.
- После настройки ручная приёмка: Safari → Google-вход → личное пространство без
  демоданных → reload/повторное открытие → logout → reload показывает вход.
  Повторить в установленной PWA и отдельно со вторым Google-аккаунтом.
- Полный набор, миграции и redeploy не запускались; код и данные не менялись.

## Публичный HTTPS staging — 2 ноября 2026, после развёртывания

- Frontend https://adamlife-2.vercel.app: Vercel Ready, production build успешен,
  commit 381ffd4ab66afae680d2e706f952b8656fe870fd; старый Flutter-проект не изменён.
- Backend https://adamlife-staging-api.onrender.com: Render Live, установка зависимостей
  и Uvicorn startup успешны. Прямой /health/ready → 200 с облачной PostgreSQL.
- Активный vercel.json совпадает с подготовленным шаблоном, кроме реального upstream.
- **9 из 9 публичных HTTPS smoke-проверок прошли**; отчёт outputs/https-staging-smoke.json:
  главная 200; /api/health/ready 200; /api/auth/config 200 (google_enabled=false);
  /api/auth/me 401; POST google/start с чужим Origin 403; logout без сессии 401;
  standalone manifest и обе иконки 200. Все проверенные API ответы no-store.
- Logout без сессии отклонён authentication dependency до Origin-проверки — ожидаемый 401.
- /auth/me выставляет удаляющий cookie с Secure, HttpOnly, SameSite=Lax, без Domain.
  Это проверка прохождения Set-Cookie через proxy, НЕ создание настоящей login-сессии.
- Браузер показывает экран входа без ошибки API, кнопку Google disabled и явную демо-кнопку.
- Google Cloud проект adamlife-staging создан; Branding ожидает согласия владельца
  с User Data Policy. OAuth client/secret ещё отсутствуют, настоящий вход НЕ проверен.
- Полная регрессия не повторялась; 269 passed / 0 skipped — предыдущий результат.
  В этом запуске нет заявлений о тестировании Safari/PWA на физическом iPhone.
- Платных ресурсов нет. Render Free засыпает; возможен timeout первого запроса.
  Бесплатная PostgreSQL истекает 2 декабря 2026; не использовать для настоящих финансов.

## Облачная PostgreSQL Render — 2 ноября 2026

- Private GitHub main 386f221 подтверждён в браузере и доступен Render. Повторная загрузка не выполнялась.
- Применён готовый database Blueprint: PostgreSQL 16, Free, Frankfurt, Available,
  отдельная база adamlife_staging. Ресурс dpg-dbk1jf67bikc738s1ul0-a.
- TLS verify-full с certifi CA: успешно. Системное хранилище CA не сработало,
  абсолютный путь с кириллицей не прочитан libpq; относительный путь решил проблему
  без отключения проверки сертификата.
- Alembic upgrade head/current/check: 0003_auth, No new upgrade operations detected.
- Runtime роль adamlife_app: без SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB и без
  членства в роли владельца. database_ready(runtime_engine) == True.
- Все 10 пользовательских/auth таблиц: RLS + FORCE RLS. Проверена видимость двух
  синтетических пользователей по app.user_id и отсутствие строк без контекста;
  транзакция с фикстурами полностью отменена, пользовательские данные не импортированы.
- Три адресные API-проверки через локальный FastAPI TestClient с реальной облачной
  runtime DB: /health/ready 200, /auth/me 401, чужой Origin на /auth/google/start 403.
  Это НЕ проверка опубликованного backend или настоящего Google OAuth.
- Временный /32 доступ был явно разрешён владельцем; после проверок закрыт,
  Dashboard показывает External traffic not allowed. Платные ресурсы не создавались.
- Полная регрессия не повторялась: предыдущие 269 passed / 0 skipped остаются
  историческим результатом, не результатом этого запуска.
- Vercel CLI credential: официальный API вернул 403; в браузере запрошено
  подтверждение Authorize Vercel через GitHub. Публичной ссылки приложения пока нет.
- Safari/PWA на физическом iPhone и настоящий Google-вход пока не проверены.

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
