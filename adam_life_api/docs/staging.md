# Тестовый HTTPS deployment — состояние 30 октября 2026

## Текущий блокер

Вход в Render через браузер подтверждён 30 октября: доступно My Workspace,
существующих сервисов нет. Команды Render MCP в чате недоступны.
Страница New Web Service показывает Connect Git provider: GitHub/GitLab/Bitbucket
ещё не подключены. Следующий шаг владельца — подключение GitHub в Render.
Vercel CLI подтвердил аккаунт adam-veynas. Реальные Google credentials отсутствуют.
Ни backend, ни облачная БД, ни новый публичный frontend в этом этапе не создавались.
Нужен доступ к Git-провайдеру. Локальная папка
не является Git-репозиторием; опубликованного репозитория AdamLife 2.0 не обнаружено.
Конфигурации не изменены, ресурсы не создавались, повторные тесты не запускались.
Секреты не запрашиваются в чат.

## Схема

Safari/PWA → HTTPS Vercel (React и /api/*) → HTTPS Render FastAPI → отдельная Render PostgreSQL.
Cookie принадлежит frontend origin, не onrender.com. Google callback:
https://<постоянный-host-frontend>/api/auth/google/callback
Preview URL с меняющимся hash не использовать как постоянный callback.
Старый Flutter Vercel-проект не перезаписывать: создать отдельный проект AdamLife 2.0.

Конфигурации подготовлены, но НЕ применены:

- deployment/render.database.yaml: новая база, PostgreSQL 16, Free, Frankfurt,
  без публичного доступа по умолчанию.
- deployment/render.service.yaml: Python 3.12.14, Free, readiness, только runtime
  DATABASE_URL. Нет owner URL, автоматических миграций или платного pre-deploy job.
- adam_life_web/deployment/vercel.example.json: no-store /api reverse proxy,
  SPA fallback, security headers. Реальный upstream заменить после выдачи адреса API.
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
