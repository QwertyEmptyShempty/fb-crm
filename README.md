# fb-tg-crm

Трекер конверсии **Facebook Ads → лендинг → Telegram** с REST API и MCP-сервером.
Считает просмотры страницы, клики, заявки в канал, подписки и отписки, привязывает всё к UTM/кампании/объявлению и отправляет события в Meta (Pixel + Conversions API).

## Как это работает

```
Реклама FB ──▶ /l/<slug>  (лендинг, Pixel PageView + серверный CAPI)
                  │ клик по кнопке
                  ▼
              /go/<visit>  создаёт уникальную инвайт-ссылку (с заявкой) через вашего бота
                  │
                  ▼
        Telegram: человек жмёт «Вступить» → заявка (chat_join_request)
                  │  бот: приветствие → автоприём заявки
                  ▼
        События: page_view → click → join_request → member_joined → left
        В Meta (CAPI): PageView · Contact · Lead · Subscribe   (имена меняются в event_map оффера)
```

Каждый клик получает **свою** ссылку-приглашение, поэтому подписчик однозначно привязывается к визиту (fbclid, fbp/fbc, UTM, ad_id…).

## Запуск

1. Создайте бота в **@BotFather** (токен понадобится на шаге 5). Создайте канал и добавьте бота админом с правом **«Приглашение пользователей»** (и «Добавление участников», если спросит).
2. Postgres + Node 20.6+. На Render: `render.yaml` создаст сервис и базу (Blueprint).
3. Переменные окружения — см. `.env.example`. Обязательны `DATABASE_URL`, `PUBLIC_URL` (https), `API_KEYS`, `ADMIN_PASSWORD` (вход в панель, мин. 8 символов; логин — `ADMIN_LOGIN`, по умолчанию `admin`).
4. `npm ci && npm run build && npm start` (локально: `npm run dev`). Схема БД создаётся сама.
5. Откройте `PUBLIC_URL/admin`, войдите и в разделах «Боты и каналы», «Пиксели», «Кампании» добавьте бота (токен из @BotFather), канал, пиксель + CAPI-токен и создайте кампанию. Во вкладке «Ссылка для рекламы» — готовая ссылка для Ads Manager.
6. То же самое можно сделать через API (или нейросеть через MCP): (или попросите нейросеть через MCP):

```bash
H='-H "authorization: Bearer $API_KEY" -H "content-type: application/json"'
API=https://your-service.onrender.com/api/v1

# 1. бот по токену — вебхук выставится автоматически
curl -X POST $API/bots $H -d '{"token":"123456789:AA..."}'
# 2. канал (ID вида -100… или @username)
curl -X POST $API/channels $H -d '{"chat":"@my_channel"}'
# 3. оффер: лендинг + приветствия
curl -X POST $API/offers $H -d '{
  "name":"Сигналы", "slug":"signals", "channel_id":"<id канала>",
  "landing":{"title":"Закрытый канал","subtitle":"Разборы каждый день","bullets":["Раз","Два"],"button_text":"Вступить"},
  "welcome":[
    {"text":"Привет, {first_name}! Добро пожаловать 👋","delay_sec":0},
    {"text":"Правила канала: …","delay_sec":60}
  ]}'
# 4. пиксель + токен Conversions API
curl -X PUT $API/offers/signals/pixel $H -d '{"fb_pixel_id":"123456789012345","capi_token":"EAA…","test_event_code":"TEST123"}'
# 5. проверка токена (событие уйдёт в Events Manager → Test Events)
curl -X POST $API/offers/signals/test-capi $H
# 6. ссылка для залива
curl $API/offers/signals/link $H
```

`/link` вернёт `ad_url` с макросами (`{{campaign.name}}`, `{{ad.id}}` …) и отдельно `url_tags` для поля «URL parameters» в Ads Manager, а также список того, что ещё не настроено.

## MCP (для нейросети)

Эндпоинт: `POST https://<домен>/mcp` (Streamable HTTP, без сессий), заголовок `Authorization: Bearer <API key>`.
Доступны те же операции, что и в REST: `add_bot`, `add_channel`, `create_offer`, `update_offer`, `attach_pixel`, `get_offer_link`, `test_capi`, `get_stats`, `list_subscribers`, `recent_events` и др. Сервер сам подсказывает клиенту порядок действий (поле `instructions`).

Пример для Claude Code: `claude mcp add --transport http fb-tg-crm https://<домен>/mcp --header "Authorization: Bearer <API key>"`.

Список операций также отдаёт `GET /api/v1/ops`, любую можно вызвать как `POST /api/v1/ops/<name>`.

## Статистика

`GET /api/v1/stats?offer=signals&group_by=utm_campaign&from=2026-10-01T00:00:00Z`

`group_by`: `none`, `day` (+`tz`), `utm_source|medium|campaign|content|term`, `campaign_id`, `adset_id`, `ad_id`, `placement`.
В ответе: views, clicks, join_requests, joined, left и конверсии между шагами. Считается по времени события.

## Что важно знать

- **Lead/Subscribe уходят только через CAPI**, т.к. происходят в Telegram, а не в браузере. Без `capi_token` в Meta попадут лишь PageView/Contact.
- `test_event_code` используется только в `test_capi`; боевые события его не содержат (иначе Meta не использует их для оптимизации).
- Приветствие с `delay_sec: 0` отправляется **до** одобрения заявки — пока она не обработана, бот может написать человеку, даже если тот не запускал бота. Отложенные сообщения доставятся, только если человек успел нажать Start у бота; недоставленные повторятся после его `/start`. Ошибки видны в `scheduled_messages.error`.
- Заявки по чужим/ручным ссылкам игнорируются (их обрабатывает админ).
- Краулеры Meta (`facebookexternalhit` и т.п.) не считаются посетителями.
- Версия Graph API — `FB_API_VERSION` (по умолчанию `v23.0`).
- **Панель** (`/admin`): аналитика с воронкой и группировкой (день, utm_*, кампания/адсет/объявление/плейсмент), CSV, кампании, редактор лендинга, приветствия, боты, пиксели, подписчики, события. Пользователь один.
- **Свой лендинг**: во вкладке «Лендинг» — встроенный шаблон с живым предпросмотром либо свой HTML / ZIP (нужен `index.html`; картинки и CSS из архива раздаются с `/l/<slug>/a/`). Кнопку к Telegram отмечайте `data-tg-link`, либо `href="{{tg_link}}"`/`href="#tg"`; `{{visit_id}}` — id визита. Пиксель и трекинг-скрипт сервер добавляет сам.
- **Свой домен** для кампании: поле «Домен» — корень этого хоста отдаёт лендинг. Панель, `/api` и `/mcp` работают только на хосте из `PUBLIC_URL`, поэтому JS чужих лендингов не делит origin с вашей сессией. Лучше держать лендинги на отдельном домене (`LANDING_URL`).
- Для изменения набора полей `landing`/`welcome`/`event_map` они заменяются целиком; `slug` менять нельзя (он зашит в рекламные ссылки).

## Структура

`src/tracking.ts` лендинг, beacon, клик · `src/bot.ts` вебхуки ботов, приветствия, планировщик · `src/capi.ts` Meta CAPI · `src/ops.ts` все операции (общие для REST и MCP) · `src/api.ts` REST · `src/mcp.ts` MCP · `src/schema.ts` БД · `src/landing.ts`, `src/landing-zip.ts` рендер и импорт лендингов · `src/session.ts`, `src/admin.ts` вход и панель · `public/` интерфейс панели (без сборки).
