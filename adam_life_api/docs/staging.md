# Тестовый HTTPS deployment — состояние 2 ноября 2026

## Развёрнуто; текущий блокер — согласие Google

Вход в Render через браузер подтверждён повторно 2 ноября: доступно My Workspace.
Команды Render MCP в чате недоступны; использован Dashboard.
GitHub Adam-Veynas подключён к Render; список репозиториев доступен.
Существующий public Adam-Veynas/adamlife содержит старый Flutter-клиент и не изменён.
Private https://github.com/Adam-Veynas/adamlife-2 загружен владельцем через
publish-adamlife-source.cmd. 2 ноября подтверждены main, обе папки исходников,
локальный main...origin/main без изменений и доступ к репозиторию из Render.
В work/adamlife-2-source подготовлен локальный Git main: 103 файла по явному
allowlist, контрольные суммы и проверка локальных credentials выполнены.
Манифест: work/staging-source-manifest.json. Исходные папки приложения не менялись.
Предыдущий блокер Git Credential Manager обойдён штатным входом владельца
через Проводник; повторная загрузка исходников не требуется.
Применён существующий adam_life_api/deployment/render.database.yaml на main
(commit 386f2218c65dbc67e2d78f025cdf6f063b45cde8).
Blueprint exs-dbk1jcec6qcc73d8rp20; база dpg-dbk1jf67bikc738s1ul0-a,
adamlife-staging-db / adamlife_staging, PostgreSQL 16, Frankfurt, Free, Available.
Дата окончания бесплатной базы по Dashboard: 2 декабря 2026.
Миграции 0003_auth применены, Alembic check без расхождений; runtime роль
adamlife_app не владелец, без SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB.
TLS с компьютера проверен verify-full через certifi CA с относительным путём
(libpq в Windows не прочитал абсолютный путь с кириллицей).
С разрешения владельца временно добавлен один /32 IP; после миграций и проверок
правило удалено. Dashboard подтвердил External traffic not allowed.
Закрытая .local/cloud-staging/connection.json содержит cloud credentials, не Git.
work/bootstrap-cloud-staging.py содержит повторяемую настройку без секретов;
при возобновлении НЕ повторять bootstrap без необходимости.

Vercel reauthentication завершена владельцем. Frontend опубликован:
https://adamlife-2.vercel.app — Hobby, Vite, root adam_life_web, main.
Последний Ready deployment FaT1vzBE2SyD8E8rRXXP4ZM11gsk, commit
381ffd4ab66afae680d2e706f952b8656fe870fd (Configure same-origin API proxy for HTTPS staging).
Добавлен adam_life_web/vercel.json по существующему шаблону с реальным upstream.
Render backend https://adamlife-staging-api.onrender.com — Free, Frankfurt,
srv-dbk1qnrbc2fs73e5tt00, deploy dep-dbk1qo3bc2fs73e5ttp0, Live.
Сервис создан вручную по параметрам service YAML, НЕ управляется Blueprint.
Python 3.12.14; build: python -m pip install -r requirements.txt; root adam_life_api.
Start command:
```sh
TRUSTED_HOSTS="[\"${RENDER_EXTERNAL_HOSTNAME}\",\"adamlife-2.vercel.app\"]" python -m uvicorn app.main:app --host 0.0.0.0 --port $PORT --no-access-log --no-proxy-headers
```
Auto-Deploy выключен. APP_ENV=production; FRONTEND_ORIGIN и CORS_ORIGINS используют
только постоянный Vercel origin. GOOGLE_REDIRECT_URI:
https://adamlife-2.vercel.app/api/auth/google/callback
Runtime DATABASE_URL использует внутренний Render host, отдельную роль и sslmode=require
(внутренний TLS Render использует self-signed сертификат). Owner URL в API не передан.
DB_POOL_SIZE=3, DB_MAX_OVERFLOW=2; lifetime=604800 и idle=86400 секунд.
Google client ID/secret отсутствуют: /api/auth/config возвращает google_enabled=false.
В Google Cloud создан отдельный проект AdamLife Staging (adamlife-staging), без биллинга.
Подготовлен Branding AdamLife 2.0 Test, External; форма остановлена на Finish перед
согласием Google API Services: User Data Policy. Настройка ещё НЕ сохранена.
Следующий шаг владельца: просмотреть правила, отметить согласие, Continue → Create
в https://console.cloud.google.com/auth/overview/create?project=adamlife-staging.
После этого нужны Web OAuth client, точный callback и закрытый ввод секрета в Render.
Не запрашивать секрет в чат. Реальные Google-входы и физический iPhone не проверены.
Корневая папка по-прежнему не является Git-репозиторием; Git настроен только
в отдельной очищенной копии work/adamlife-2-source.
Код приложения не изменён; добавлен только deployment vercel.json. Полный набор тестов
не повторялся. Девять публичных HTTPS smoke-проверок прошли; подробности в verification.md.
Локальная очищенная Git-копия work/adamlife-2-source пока на 386f221; новый vercel.json
добавлен в исходную папку и GitHub через UI. Не перезаписывать remote старой копией.
Секреты не запрашиваются в чат.

## Схема

Safari/PWA → HTTPS Vercel (React и /api/*) → HTTPS Render FastAPI → отдельная Render PostgreSQL.
Cookie принадлежит frontend origin, не onrender.com. Google callback:
https://<постоянный-host-frontend>/api/auth/google/callback
Preview URL с меняющимся hash не использовать как постоянный callback.
Старый Flutter Vercel-проект не перезаписывать: создать отдельный проект AdamLife 2.0.

Конфигурации:

- deployment/render.database.yaml: ПРИМЕНЕНА; новая база, PostgreSQL 16, Free, Frankfurt,
  без публичного доступа по умолчанию.
- deployment/render.service.yaml: использована как основа ручной настройки сервиса;
  Blueprint НЕ применён. Python 3.12.14, Free, readiness, только runtime DATABASE_URL.
  Нет owner URL, автоматических миграций или платного pre-deploy job.
- adam_life_web/deployment/vercel.example.json: no-store /api reverse proxy,
  SPA fallback, security headers. Реальный upstream уже установлен в adam_life_web/vercel.json.
- adam_life_web/.vercelignore и .gitignore: запрет env/local/cache/config uploads.

Настоящие домены и секреты не заменены вымышленными значениями для обхода валидации.
Не применять оба Render blueprint одновременно: сначала база и роли, затем API.
Окончательные параметры проверяются в аккаунте перед созданием. Если Free недоступен,
есть задолженность, требуется платный план или банковская карта — остановиться.

## Порядок технической работы после подключения

1. Проверить workspace, тариф, существующие ресурсы и отсутствие платного расширения.
   Free web service засыпает после 15 минут простоя; cold start около минуты.
   Free PostgreSQL истекает через 30 дней, не имеет backups. Это временный тест,
   не хранилище настоящих финансов. Не продлевать/обновлять платно автоматически.
2. Подготовить отдельный **приватный** Git-репозиторий с исходниками двух папок:
   adam_life_api и adam_life_web. Перед загрузкой составить и проверить явный список
   файлов. Не выполнять git add . из общего workspace.
   Никогда не загружать .env, .local, .venv, pgdata, local-settings.json, дампы,
   архивы outputs/work, старые клиенты, browser storage, node_modules или логи.
   Source-код прототипных примеров допустим, пользовательское содержимое хранилища — нет.
   Не публиковать репозиторий как public ради обхода подключения Render.
3. Создать отдельную пустую cloud DB adamlife_staging. Проверить её ID/host/имя:
   это НЕ localhost, НЕ adamlife и НЕ adamlife_test. Для настройки с компьютера
   временно разрешить только подтверждённый внешний IP /32, не 0.0.0.0/0.
4. Под владельцем новой БД создать отдельную LOGIN роль adamlife_app без SUPERUSER,
   CREATEDB, CREATEROLE, BYPASSRLS и без членства в owner. Сгенерировать новый пароль
   локально; хранить только в закрытых env/секретах Render, не в командах/логах.
   Проверить доступные права Render; если отдельную роль создать нельзя, НЕ запускать
   API под owner и не ослаблять readiness/RLS.
5. Применить существующие Alembic миграции через отдельное временное окружение
   оператора с MIGRATION_DATABASE_URL новой облачной БД и TLS:
   python -m alembic upgrade head; python -m alembic current; python -m alembic check.
   Не изменять локальную .env. Выполнить scripts/grant-runtime.sql владельцем
   облачной БД. Проверить runtime role и RLS. Никаких seed/import/demo данных.
6. Runtime DATABASE_URL — URL роли adamlife_app, не URL владельца из Dashboard.
   Проверить TLS к реальному endpoint (предпочтительно verify-full, иначе require
   только после проверки ограничений провайдера). Не подставлять disable.
   API и DB в одном регионе, использовать internal endpoint, если TLS поддерживается.
   После настройки убрать временный /32 доступ.
7. Собрать frontend, получить постоянный Vercel staging alias и адрес Render API.
   Настроить реальные FRONTEND_ORIGIN, GOOGLE_REDIRECT_URI, CORS_ORIGINS,
   TRUSTED_HOSTS и Vercel rewrite. Из frontend обращаться только к /api.
   Проверить отсутствие Vercel Deployment Protection для тестеров либо согласованный
   доступ: нельзя выдавать экран входа Vercel за вход AdamLife.
8. Настроить Google по разделу ниже, проверить proxy/set-cookie/no-store и реальные
   входы. На тестовом окружении должны быть доступны только согласованные тестеры
   Google; проверить фактическое ограничение consent screen для используемых scopes.
   Если Google допускает более широкую аудиторию, до приглашения тестеров требуется
   отдельное ограничение доступа, а не предположение о закрытости.
9. Проверить edge rate limiting и отсутствие секретов в логах callback. Если
   выбранный бесплатный тариф этого не позволяет, не заявлять internet hardening
   завершённым: ограничить тестовый доступ или согласовать альтернативу.

## Переменные

| Ключ | Значение |
| --- | --- |
| APP_ENV | production, даже для staging |
| FRONTEND_ORIGIN | точный https:// постоянный Vercel alias, без / в конце |
| GOOGLE_REDIRECT_URI | FRONTEND_ORIGIN + /api/auth/google/callback |
| CORS_ORIGINS | JSON-массив только FRONTEND_ORIGIN |
| TRUSTED_HOSTS | JSON-массив фактических Render/Vercel hostnames, без схем/портов |
| DATABASE_URL | облачная runtime роль + TLS, не migration owner |
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET | реальные значения из Google; только backend |

Никакие секреты не должны иметь VITE_ prefix. MIGRATION_DATABASE_URL доступен только
оператору миграций, не постоянно работающему backend.

## Google Cloud — настройки после получения точного HTTPS адреса

Отдельный staging project. Google Auth Platform:

- Branding: AdamLife 2.0 Test, email поддержки и контакт владельца.
- Audience: External, Testing; добавить два согласованных тестовых Google-аккаунта.
- Data Access: только openid, email, profile. Никаких банковских/Drive/Gmail scopes.
- Client: Web application. Authorized redirect URI — точный HTTPS callback выше.
  Localhost callback добавлять только для отдельной согласованной локальной проверки.
- Authorized domains: домен, обслуживающий frontend/callback, без схемы/пути.
  Точное значение и допустимость домена Vercel проверить в Console после выдачи URL.
  Не добавлять случайный общий vercel.app/onrender.com и не заявлять владение доменом
  провайдера. Если Google потребует собственный подтверждённый домен — запросить его
  у владельца; не покупать домен самостоятельно.
- Authorized JavaScript origins для server-side flow не требуются.
- Client secret владелец вводит прямо в закрытое поле Render; для локальной проверки
  есть configure-google.cmd. Никаких секретов в сообщениях, скриншотах и frontend.

Для consent/создания credentials могут понадобиться личное участие и принятие условий
Google. Агент не принимает договоры и не вводит новые credentials вместо владельца.

## Проверки после реального deployment

- Прямой backend и frontend /api/health/ready: 200, реальная облачная БД/0003_auth.
- /api/auth/me без cookie: 401; чужой Origin на start/logout: отказ.
- Реальные Google регистрация, повторный вход, отмена, reload, logout, replay cookie.
- Два разных Google sub создают разные users; отсутствует доступ к чужим строкам.
  Не открывать тестовые /test/accounts endpoints в публичном приложении.
- Исходные интеграционные тесты с destructive teardown запускать только на выделенной
  disposable test DB; НИКОГДА не на staging с созданными Google-пользователями.
- Secure/HttpOnly/SameSite=Lax host-only cookies, отсутствие CDN-кэширования /api.
- Safari и установленная PWA на физическом iPhone: Google возврат, восстановление,
  закрытие/открытие, выход. Desktop/responsive screenshot не заменяет эту проверку.
- На Free cold start может превышать 10-секундный timeout frontend: показать ошибку
  и повторить после прогрева, не отключать проверки сессии и не подставлять демо.

Источники:
[Render Free](https://render.com/docs/free),
[Render Blueprint](https://render.com/docs/blueprint-spec),
[Render FastAPI](https://render.com/docs/deploy-fastapi),
[Vercel rewrites](https://vercel.com/docs/routing/rewrites),
[Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).
