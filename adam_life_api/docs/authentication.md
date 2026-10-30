# Авторизация AdamLife 2.0

## Что реализовано

Google OpenID Connect Authorization Code Flow, серверный обмен code, PKCE S256,
state и nonce. Flow связан с HttpOnly cookie браузера, живёт 10 минут и атомарно
потребляется один раз. ID token проверяется PyJWT/cryptography: RSA/RS256, Google
JWKS, issuer, audience, exp, iat, nonce, sub, azp (nbf — если присутствует).
Допускается 30 секунд рассинхронизации часов. URL провайдера фиксированы.
Пользователь определяется только по Google sub; email не объединяет аккаунты.
Одновременный первый вход использует атомарный upsert.

Серверная сессия — случайный 256-битный opaque token, в PostgreSQL только SHA-256.
Cookie host-only, HttpOnly, SameSite=Lax, Path=/; на HTTPS Secure и префикс __Host-.
Срок по умолчанию 7 суток, неактивность — 1 сутки. Повторный вход заменяет сессию
этого браузера; другие устройства сохраняют свои независимые сессии.
Logout ставит revoked_at; просроченные/отозванные сессии дают 401.
Это отзыв **сессии AdamLife**, не выход из Google. Google RISC/webhooks и
автоматический отзыв локальной сессии при отзыве согласия в Google не реализованы.

POST start требует точный Origin. POST logout дополнительно требует X-CSRF-Token,
полученный с /me и хранимый только в памяти React. Provider access/refresh tokens
не сохраняются и не передаются клиенту; ID token используется только при входе.
Нет bearer-токенов в localStorage/sessionStorage, cookie Domain или сторонних cookies.
Ошибки и callback не отражают произвольный return URL; Cache-Control: no-store.
Логи Uvicorn без access log. Логи хостинга тоже обязаны скрывать code, cookies,
заголовки авторизации и тела обмена токенами.

## API

Браузер обращается к /api; Vite/production reverse proxy убирает этот префикс.

| Метод и путь backend | Назначение |
| --- | --- |
| GET /auth/config | Доступна ли настройка Google, без секретов |
| POST /auth/google/start | Выдать URL Google и cookie одноразового flow |
| GET /auth/google/callback | Проверить flow/code/token, создать сессию, 303 на frontend |
| GET /auth/me | Проверить сессию, вернуть user, csrf_token, expires_at |
| POST /auth/logout | Отозвать сессию и удалить cookies |
| GET /health/ready | Проверить PostgreSQL, роль и ревизию |

Существующий формат error/code/message/details/request_id сохранён.
401 — нужна сессия, 403 — неверный Origin/CSRF, 503 GOOGLE_NOT_CONFIGURED —
ключи не настроены. Ошибка callback возвращает только фиксированный код в URL.
Frontend показывает понятное состояние, а не включает демо автоматически.

## Изоляция

auth_sessions/login_flows имеют FORCE RLS по хешу предъявленного cookie.
После проверки сессии authenticated_session устанавливает SET LOCAL app.user_id
из записи БД, а не из запроса. Пользовательские таблицы сохраняют исходные RLS/FK/
триггеры. Узкие политики users для app.google_sub используются только после
проверки Google; API не позволяет клиенту устанавливать такой контекст.
Контекст живёт только в транзакции, соединения пула не сохраняют пользователя.
Сессия блокируется FOR UPDATE до завершения запроса, включая logout.
Будущие финансовые маршруты должны использовать этот dependency с
Depends(..., scope="function") и CSRF-проверку для всех изменяющих запросов.

React очищает профиль/CSRF из памяти при выходе, ошибке проверки и смене пользователя;
поздние ответы предыдущего запроса отбрасываются. Проверка при возврате на вкладку,
pageshow, истечении и раз в минуту. Logout сообщает другим вкладкам только событие,
не токены. Демонстрация включается вручную и загружается отдельно. Серверный аккаунт
пока показывает пустое пространство: финансовый CRUD намеренно не реализован.

## Включение Google локально — действия владельца

1. В Google Cloud / Google Auth Platform настройте consent screen и создайте OAuth
   client типа **Web application**. В режиме Testing добавьте свой Google-аккаунт
   в тестовые пользователи. Scopes: только openid, email, profile.
2. Добавьте точный Authorized redirect URI:
   http://localhost:5173/api/auth/google/callback
   (JavaScript SDK не используется, Authorized JavaScript origins не требуется.)
3. Откройте configure-google.cmd в adam_life_api. Введите Client ID и Client secret
   в локальном окне. Секрет скрыт и сохраняется только в исключённой из Git .env;
   не отправляйте ключи в чат и не помещайте их в VITE_*.
4. Перезапустите backend через start-api.cmd, запустите frontend через
   adam_life_web/start-adamlife.cmd и откройте http://localhost:5173/.
   127.0.0.1 и localhost — разные origin; для Google используйте именно localhost.

Никакие аккаунты, credentials или платные сервисы автоматически не создавались.
Существующие пароли PostgreSQL помощник не меняет.

## HTTPS / Vercel / iPhone

Предпочтителен **один browser origin**: https://APP_HOST для React и
https://APP_HOST/api/* через reverse proxy к HTTPS backend. Это работает без
cross-site cookies между Vercel и независимым доменом API. Не отключать Secure/
SameSite для обхода Safari. Не делать клиентский редирект на прямой API-домен.

Шаблон proxy: adam_life_web/deployment/vercel.example.json. Он не активирован:
заменить api.example.invalid реальным адресом backend и использовать как vercel.json
только после выбора хостинга. Proxy должен сохранять Set-Cookie и Origin,
не кэшировать /api, исключать callback из SPA fallback и не логировать query.
Google callback регистрируется на **frontend** origin.

Production env backend:

    APP_ENV=production
    FRONTEND_ORIGIN=https://APP_HOST
    GOOGLE_REDIRECT_URI=https://APP_HOST/api/auth/google/callback
    CORS_ORIGINS=["https://APP_HOST"]
    TRUSTED_HOSTS=["API_HOST","APP_HOST"]
    GOOGLE_CLIENT_ID=<Web client ID>
    GOOGLE_CLIENT_SECRET=<secret manager value>
    DATABASE_URL=<runtime PostgreSQL URL with TLS>

Миграции отдельным job/owner URL; API без прав owner/SUPERUSER/BYPASSRLS.
Подставить реальные hosts, без схем/портов в TRUSTED_HOSTS.
Обязательно проверить proxy на реальном сервисе, включая cookies и отсутствие
кэширования. Production ограничение частоты /auth/google/start и callback на
reverse proxy/WAF, мониторинг, резервные копии и регламент удаления истёкших flows/
sessions — эксплуатационные пункты перед публичным запуском. Здесь отдельные
сервисы, WAF, планировщики и автоматическая очистка БД не создавались.

Проверка приёмки на физическом iPhone после HTTPS-публикации:

- Safari: новый вход, повторный вход, отмена Google, выход, повторное открытие.
- Добавить на экран Домой, запустить standalone; вход и возврат после Google,
  закрытие/открытие, выход и отсутствие данных прошлого пользователя.
- Проверить второй аккаунт/вкладку и отсутствие циклических редиректов.
- Убедиться, что cookie принадлежит APP_HOST, имеет Secure/HttpOnly/SameSite=Lax,
  /api/auth/me не кэшируется и без cookie возвращает 401.

Редирект выполняется в том же окне, без popup и переноса сессии через localStorage.
Если iOS открывает Google в Safari вне PWA с отдельным cookie-контекстом, flow
без правильного cookie отклоняется: это безопасный отказ, а не обход защиты.
Поведение конкретной версии iOS требует проверки до приёмки. LAN HTTP и эмуляция
размера экрана эту проверку не заменяют. Offline-вход не поддерживается.

## Проверки и границы

Автотесты используют настоящую отдельную PostgreSQL, реальные RSA-подписи и
проверку ID token. Только HTTP Google подменён тестовым transport: не требуется
интернет-аккаунт, тестовые данные не попадают в development. Подробные результаты —
verification.md. Mock-проверки не являются подтверждением реального входа Google.

Официальный контракт:
[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect),
[Google Web Server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).
