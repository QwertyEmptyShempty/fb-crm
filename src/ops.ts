// Единый слой операций. Его используют и REST API, и MCP-сервер —
// поэтому нейросеть и обычный клиент делают ровно одно и то же.
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { cfg } from './config.js';
import { q, q1, HttpError } from './db.js';
import { sendCapi, type PixelRow } from './capi.js';
import { clientFor, TgClient } from './telegram.js';
import { ctaCount } from './landing.js';
import { addDomain, checkDomain, deleteDomain, ensureDomain, listDomains, normalizeHost } from './domains.js';
import {
  type BotRow,
  clearOfferCache,
  eventNameFor,
  getOfferFull,
  isUuid,
  listOffersFull,
  type OfferFull,
} from './core.js';

export interface Op {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  run: (input: unknown) => Promise<unknown>;
}

export const ops: Op[] = [];

function def<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (input: z.infer<z.ZodObject<S>>) => Promise<unknown>,
) {
  const schema = z.object(shape);
  ops.push({ name, description, shape, run: async (raw) => run(schema.parse(raw ?? {})) });
}

// ───────────────────────── схемы ─────────────────────────

const uuid = z.string().uuid();
const offerKey = z.string().min(1).describe('id (uuid) или slug оффера');

export const landingSchema = z
  .object({
    title: z.string().max(120).optional(),
    subtitle: z.string().max(400).optional().describe('Короткое описание под заголовком'),
    text: z.string().max(2000).optional().describe('Основной текст (переносы строк сохраняются)'),
    avatar_url: z.string().url().max(500).optional().describe('Круглая аватарка канала'),
    count_text: z.string().max(60).optional().describe('Например «12 480 подписчиков»'),
    image_url: z.string().url().max(500).optional().describe('Крупная картинка над заголовком'),
    button_text: z.string().max(40).optional(),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'HEX вида #2AABEE').optional(),
    theme: z.enum(['dark', 'light']).optional(),
    bullets: z.array(z.string().max(160)).max(6).optional(),
    footer: z.string().max(300).optional(),
    custom_css: z.string().max(20000).optional().describe('Свои стили (CSS)'),
    head_html: z.string().max(20000).optional().describe('Свой код в <head> (например, другие пиксели, аналитика)'),
    body_html: z.string().max(20000).optional().describe('Свой код в конце <body>'),
  })
  .strict()
  .describe('Настройки встроенного (default) лендинга');

const domainSchema = z
  .string()
  .transform(normalizeHost)
  .pipe(z.string().regex(/^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,}$/, 'Домен вида track.example.com'));
export const landingTypeSchema = z.enum(['default', 'custom']).describe('default — встроенный шаблон; custom — свой HTML/ZIP');
export const landingHtmlSchema = z
  .string()
  .max(500_000)
  .describe('Свой HTML лендинга. Кнопка перехода: атрибут data-tg-link или href="{{tg_link}}"');

const stepSchema = z
  .object({
    text: z.string().min(1).max(4000).describe('Текст (HTML Telegram: <b>, <i>, <a>). Подстановки: {first_name}, {username}'),
    delay_sec: z.number().int().min(0).max(7 * 86400).default(0).describe('Задержка после заявки, сек. 0 = сразу'),
    photo_url: z.string().url().optional(),
    buttons: z
      .array(z.object({ text: z.string().min(1).max(60), url: z.string().url() }))
      .max(4)
      .optional(),
  })
  .strict()
  .refine((s) => !s.photo_url || s.text.length <= 1024, 'С photo_url текст (подпись) не длиннее 1024 символов');

const welcomeSchema = z.array(stepSchema).max(10).describe('Цепочка приветственных сообщений');

const eventMapSchema = z
  .object({
    page_view: z.string().max(50).nullable(),
    click: z.string().max(50).nullable(),
    join_request: z.string().max(50).nullable(),
    member_joined: z.string().max(50).nullable(),
  })
  .partial()
  .strict()
  .describe('Имена событий Meta по этапам (null = не отправлять). По умолчанию: PageView / Contact / Lead / Subscribe');

const fbPixelId = z.string().regex(/^\d{5,20}$/, 'ID пикселя — только цифры');

// ───────────────────────── утилиты ─────────────────────────

const maskToken = (t: string | null) => (t ? `${t.slice(0, 6)}…${t.slice(-4)}` : null);

const pixelOut = (p: any) => ({
  id: p.id,
  name: p.name,
  pixel_id: p.pixel_id,
  has_capi_token: !!p.capi_token,
  capi_token_masked: maskToken(p.capi_token),
  test_event_code: p.test_event_code,
  created_at: p.created_at,
});

const channelOut = (c: any) =>
  c && {
    id: c.id,
    name: c.name,
    chat_id: String(c.chat_id),
    title: c.title,
    username: c.username,
    bot_id: c.bot_id,
  };

const botOut = (b: any) => ({
  id: b.id,
  name: b.name,
  username: b.username,
  tg_id: String(b.tg_id),
  token_masked: maskToken(b.token),
  webhook_url: `${cfg.PUBLIC_URL}/tg/webhook/${b.id}`,
  created_at: b.created_at,
});

export const landingBase = (o: { domain: string | null }) =>
  o.domain ? `https://${o.domain}` : (cfg.LANDING_URL ?? cfg.PUBLIC_URL);

const offerOut = (o: OfferFull, full = false) => ({
  id: o.id,
  slug: o.slug,
  name: o.name,
  status: o.status,
  auto_approve: o.auto_approve,
  domain: o.domain,
  landing_type: o.landing_type,
  landing: o.landing,
  has_landing_html: !!o.landing_html,
  has_assets: o.has_assets,
  cta_count: o.landing_type === 'custom' ? ctaCount(o.landing_html) : null,
  ...(full ? { landing_html: o.landing_html } : {}),
  welcome: o.welcome,
  event_map: o.event_map,
  pixel: o.pixel ? pixelOut(o.pixel) : null,
  channel: channelOut(o.channel),
  bot: o.bot ? { id: o.bot.id, username: o.bot.username } : null,
  landing_url: `${landingBase(o)}/l/${o.slug}`,
  short_url: o.domain ? `https://${o.domain}/` : null,
  created_at: o.created_at,
});

async function mustOffer(key: string): Promise<OfferFull> {
  const o = await getOfferFull(key);
  if (!o) throw new HttpError(404, `Оффер не найден: ${key}`);
  return o;
}

async function patchRow(table: string, id: string, data: Record<string, unknown>, jsonCols: string[] = []) {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (!keys.length) throw new HttpError(400, 'Не переданы поля для обновления');
  const sets = keys.map((k, i) => `${k} = $${i + 2}${jsonCols.includes(k) ? '::jsonb' : ''}`);
  if (table === 'offers') sets.push('updated_at = now()');
  const vals = keys.map((k) => (jsonCols.includes(k) ? JSON.stringify(data[k]) : data[k]));
  return q1(`update ${table} set ${sets.join(', ')} where id = $1 returning *`, [id, ...vals]);
}

const isUniqueViolation = (e: unknown) => (e as any)?.code === '23505';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);

// ───────────────────────── пиксели ─────────────────────────

def('list_pixels', 'Список пикселей Facebook (токены CAPI скрыты).', {}, async () =>
  (await q('select * from pixels order by created_at desc')).map(pixelOut),
);

def(
  'create_pixel',
  'Добавить пиксель Facebook. capi_token — токен Conversions API: без него события Lead/Subscribe (они происходят в Telegram, не в браузере) в Meta не попадут.',
  {
    name: z.string().min(1).max(100),
    pixel_id: fbPixelId,
    capi_token: z.string().min(20).optional(),
    test_event_code: z.string().max(40).optional().describe('Код из Events Manager → Test Events'),
  },
  async (i) => {
    try {
      const p = await q1(
        'insert into pixels (name, pixel_id, capi_token, test_event_code) values ($1,$2,$3,$4) returning *',
        [i.name, i.pixel_id, i.capi_token ?? null, i.test_event_code ?? null],
      );
      return pixelOut(p);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'Пиксель с таким ID уже добавлен');
      throw e;
    }
  },
);

def(
  'update_pixel',
  'Изменить пиксель (имя, ID, токен CAPI, тестовый код). null очищает токен/код.',
  {
    id: uuid,
    name: z.string().min(1).max(100).optional(),
    pixel_id: fbPixelId.optional(),
    capi_token: z.string().min(20).nullable().optional(),
    test_event_code: z.string().max(40).nullable().optional(),
  },
  async ({ id, ...rest }) => {
    const p = await patchRow('pixels', id, rest);
    if (!p) throw new HttpError(404, 'Пиксель не найден');
    clearOfferCache();
    return pixelOut(p);
  },
);

def('delete_pixel', 'Удалить пиксель (у офферов он отвяжется).', { id: uuid }, async ({ id }) => {
  const r = await q1('delete from pixels where id = $1 returning id', [id]);
  if (!r) throw new HttpError(404, 'Пиксель не найден');
  clearOfferCache();
  return { deleted: true };
});

// ───────────────────────── боты ─────────────────────────

export const webhookUrl = (botId: string) => `${cfg.PUBLIC_URL}/tg/webhook/${botId}`;

/** Выставить вебхук бота. Возвращает текст ошибки или null. */
export async function syncWebhook(bot: BotRow): Promise<string | null> {
  try {
    await clientFor(bot.token).setWebhook(webhookUrl(bot.id), bot.webhook_secret);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

async function mustBot(key: string): Promise<BotRow> {
  const where = isUuid(key) ? 'id = $1' : 'lower(username) = lower($1)';
  const b = await q1<BotRow>(`select * from bots where ${where}`, [key.replace(/^@/, '')]);
  if (!b) throw new HttpError(404, `Бот не найден: ${key}`);
  return b;
}

def('list_bots', 'Список подключённых Telegram-ботов (токены скрыты).', {}, async () =>
  (await q('select * from bots order by created_at desc')).map(botOut),
);

def(
  'add_bot',
  'Подключить своего Telegram-бота по токену от @BotFather. Сервис проверит токен и сам выставит вебхук. Затем добавьте бота админом в канал (право «Приглашение пользователей») и вызовите add_channel.',
  {
    token: z.string().regex(/^\d{6,}:[A-Za-z0-9_-]{30,}$/, 'Токен вида 123456789:AAH…').describe('Токен бота из @BotFather'),
    name: z.string().min(1).max(100).optional().describe('Внутреннее название (по умолчанию @username)'),
  },
  async (i) => {
    let me;
    try {
      me = await new TgClient(i.token).me();
    } catch (e) {
      throw new HttpError(400, `Telegram не принял токен: ${(e as Error).message}`);
    }
    const bot = (await q1<BotRow>(
      `insert into bots (name, token, username, tg_id, webhook_secret) values ($1,$2,$3,$4,$5)
       on conflict (tg_id) do update set token = excluded.token, username = excluded.username,
         name = coalesce($6, bots.name)
       returning *`,
      [i.name ?? `@${me.username}`, i.token, me.username, me.id, randomBytes(24).toString('base64url'), i.name ?? null],
    ))!;
    const webhookError = await syncWebhook(bot);
    return {
      bot: botOut(bot),
      warnings: webhookError
        ? [`Вебхук не установлен: ${webhookError}. PUBLIC_URL должен быть публичным https-адресом; после исправления вызовите refresh_webhook.`]
        : [],
    };
  },
);

def('refresh_webhook', 'Переустановить вебхук бота (после смены домена/PUBLIC_URL).', { bot: z.string().min(1).describe('id или @username бота') }, async ({ bot }) => {
  const b = await mustBot(bot);
  const err = await syncWebhook(b);
  if (err) throw new HttpError(502, `Telegram: ${err}`);
  return { ok: true, webhook_url: webhookUrl(b.id) };
});

def('delete_bot', 'Отключить бота (вебхук снимается, его каналы удаляются из CRM; сами каналы в Telegram не затрагиваются).', { bot: z.string().min(1) }, async ({ bot }) => {
  const b = await mustBot(bot);
  await clientFor(b.token).deleteWebhook().catch(() => {});
  await q('delete from bots where id = $1', [b.id]);
  clearOfferCache();
  return { deleted: true };
});

// ───────────────────────── каналы ─────────────────────────

def('list_channels', 'Список подключённых Telegram-каналов/групп.', {}, async () =>
  (await q('select * from channels order by created_at desc')).map(channelOut),
);

def(
  'add_channel',
  'Подключить канал/группу к боту. Бот должен быть администратором с правом «Приглашение пользователей». Укажите ID (-100…) или @username публичного канала.',
  {
    chat: z.union([z.string().min(1), z.number()]).describe('ID чата (-100…) или @username'),
    bot: z.string().min(1).optional().describe('id или @username бота; можно не указывать, если подключён ровно один бот'),
    name: z.string().max(100).optional().describe('Внутреннее название (по умолчанию — название канала)'),
  },
  async (i) => {
    let bot: BotRow;
    if (i.bot) bot = await mustBot(i.bot);
    else {
      const all = await q<BotRow>('select * from bots');
      if (all.length === 0) throw new HttpError(400, 'Нет подключённых ботов — сначала add_bot');
      if (all.length > 1) throw new HttpError(400, 'Подключено несколько ботов — укажите параметр bot');
      bot = all[0]!;
    }
    const client = clientFor(bot.token);
    const ref = typeof i.chat === 'string' && /^-?\d+$/.test(i.chat) ? Number(i.chat) : i.chat;
    let chat: any;
    try {
      chat = await client.getChat(ref);
    } catch (e) {
      throw new HttpError(400, `Telegram: ${(e as Error).message}. Добавьте бота @${bot.username} в канал и проверьте ID.`);
    }
    const warnings: string[] = [];
    try {
      const m = await client.getChatMember(chat.id, Number(bot.tg_id));
      if (m.status !== 'administrator' && m.status !== 'creator') {
        warnings.push(`Бот @${bot.username} не администратор канала — ссылки-приглашения создать не получится.`);
      } else if (m.status === 'administrator' && !m.can_invite_users) {
        warnings.push('У бота нет права «Приглашение пользователей».');
      }
    } catch {
      warnings.push('Не удалось проверить права бота в канале.');
    }
    const row = await q1(
      `insert into channels (name, chat_id, title, username, bot_id) values ($1,$2,$3,$4,$5)
       on conflict (chat_id) do update set title = excluded.title, username = excluded.username,
         bot_id = excluded.bot_id, name = coalesce($6, channels.name)
       returning *`,
      [i.name ?? chat.title ?? String(chat.id), chat.id, chat.title ?? null, chat.username ?? null, bot.id, i.name ?? null],
    );
    clearOfferCache();
    return { channel: channelOut(row), warnings };
  },
);

def('delete_channel', 'Удалить канал (у офферов он отвяжется).', { id: uuid }, async ({ id }) => {
  const r = await q1('delete from channels where id = $1 returning id', [id]);
  if (!r) throw new HttpError(404, 'Канал не найден');
  clearOfferCache();
  return { deleted: true };
});

// ───────────────────────── офферы ─────────────────────────

def('list_offers', 'Список офферов (связка лендинг → канал → пиксель).', {
  status: z.enum(['active', 'paused']).optional(),
}, async ({ status }) => (await listOffersFull(status)).map((o) => offerOut(o)));

def('get_offer', 'Оффер по id или slug (включая свой HTML лендинга).', { offer: offerKey }, async ({ offer }) =>
  offerOut(await mustOffer(offer), true),
);

async function assertRefs(pixelId?: string | null, channelId?: string | null) {
  if (pixelId && !(await q1('select 1 from pixels where id = $1', [pixelId])))
    throw new HttpError(404, 'Пиксель (pixel_id) не найден — сначала create_pixel');
  if (channelId && !(await q1('select 1 from channels where id = $1', [channelId])))
    throw new HttpError(404, 'Канал (channel_id) не найден — сначала add_channel');
}

def(
  'create_offer',
  'Создать оффер: лендинг + канал Telegram + пиксель + приветствия. Возвращает ссылку лендинга; для готовой ссылки под рекламу вызовите get_offer_link.',
  {
    name: z.string().min(1).max(100),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,40}$/, 'a-z, 0-9 и дефис, 3–41 символ').optional(),
    pixel_id: uuid.optional().describe('uuid пикселя из list_pixels'),
    channel_id: uuid.optional().describe('uuid канала из list_channels'),
    domain: domainSchema.optional().describe('Свой домен для лендинга (DNS на этот сервис)'),
    landing_type: landingTypeSchema.optional(),
    landing_html: landingHtmlSchema.optional(),
    landing: landingSchema.optional(),
    welcome: welcomeSchema.optional(),
    auto_approve: z.boolean().default(true).describe('Автоматически принимать заявки на вступление'),
    event_map: eventMapSchema.optional(),
  },
  async (i) => {
    await assertRefs(i.pixel_id, i.channel_id);
    if (i.domain) await ensureDomain(i.domain);
    const base = i.slug ?? (slugify(i.name) || 'offer');
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = i.slug && attempt === 0 ? i.slug : `${base}-${randomBytes(2).toString('hex')}`;
      try {
        await q1(
          `insert into offers (slug, name, pixel_id, channel_id, domain, landing_type, landing_html, landing, welcome, auto_approve, event_map)
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb) returning id`,
          [
            slug,
            i.name,
            i.pixel_id ?? null,
            i.channel_id ?? null,
            i.domain ?? null,
            i.landing_type ?? (i.landing_html ? 'custom' : 'default'),
            i.landing_html ?? null,
            JSON.stringify(i.landing ?? {}),
            JSON.stringify(i.welcome ?? []),
            i.auto_approve,
            JSON.stringify(i.event_map ?? {}),
          ],
        );
        clearOfferCache();
        return offerOut(await mustOffer(slug), true);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        if (String((e as any).constraint ?? '').includes('domain')) throw new HttpError(409, `Домен ${i.domain} уже привязан к другому офферу`);
        if (i.slug && attempt === 0) throw new HttpError(409, `Slug «${i.slug}» уже занят`);
      }
    }
    throw new HttpError(500, 'Не удалось подобрать свободный slug');
  },
);

def(
  'update_offer',
  'Изменить оффер. landing, welcome и event_map заменяются целиком; для своего лендинга задайте landing_type=custom и landing_html. Slug менять нельзя (он зашит в рекламные ссылки). pixel_id/channel_id = null отвязывают.',
  {
    offer: offerKey,
    name: z.string().min(1).max(100).optional(),
    status: z.enum(['active', 'paused']).optional(),
    pixel_id: uuid.nullable().optional(),
    channel_id: uuid.nullable().optional(),
    domain: domainSchema.nullable().optional(),
    landing_type: landingTypeSchema.optional(),
    landing_html: landingHtmlSchema.nullable().optional(),
    landing: landingSchema.optional(),
    welcome: welcomeSchema.optional(),
    auto_approve: z.boolean().optional(),
    event_map: eventMapSchema.optional(),
  },
  async ({ offer, ...rest }) => {
    const o = await mustOffer(offer);
    await assertRefs(rest.pixel_id, rest.channel_id);
    if (rest.domain) await ensureDomain(rest.domain);
    try {
      await patchRow('offers', o.id, rest, ['landing', 'welcome', 'event_map']);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, `Домен ${rest.domain} уже привязан к другому офферу`);
      throw e;
    }
    clearOfferCache();
    return offerOut(await mustOffer(o.id), true);
  },
);

def(
  'delete_offer',
  'Удалить оффер вместе со всей его статистикой (визиты, события, подписчики). Необратимо.',
  { offer: offerKey },
  async ({ offer }) => {
    const o = await mustOffer(offer);
    await q('delete from offers where id = $1', [o.id]);
    clearOfferCache();
    return { deleted: true, slug: o.slug };
  },
);

def('list_domains', 'Список подключённых доменов лендингов со статусом, кампаниями и инструкцией по DNS-записям для каждого.', {}, async () => listDomains());

def(
  'add_domain',
  'Добавить домен для лендингов (go.example.com или example.com). Возвращает DNS-записи, которые нужно создать у регистратора. Затем check_domain. Привязать домен к кампании: update_offer с domain.',
  { host: z.string().min(3).max(300).describe('Домен, например go.example.com') },
  async ({ host }) => addDomain(host),
);

def(
  'check_domain',
  'Проверить домен: DNS-записи и доступность по https. Статус active — домен готов, pending — в поле problem понятная причина.',
  { domain: z.string().min(3).describe('id или host домена') },
  async ({ domain }) => checkDomain(domain),
);

def(
  'delete_domain',
  'Удалить домен из списка (если он не привязан ни к одной кампании).',
  { domain: z.string().min(3).describe('id или host домена') },
  async ({ domain }) => deleteDomain(domain),
);

/** Операции, которые не отдаём нейросети через MCP (необратимые). */
export const MCP_HIDDEN = new Set(['delete_offer', 'delete_domain']);

def(
  'attach_pixel',
  'Подвязать пиксель к офферу по ID пикселя Facebook и токену CAPI. Если такой пиксель уже есть — переиспользуется (токен обновится, если передан).',
  {
    offer: offerKey,
    fb_pixel_id: fbPixelId,
    capi_token: z.string().min(20).optional(),
    test_event_code: z.string().max(40).optional(),
    name: z.string().min(1).max(100).optional(),
  },
  async (i) => {
    const o = await mustOffer(i.offer);
    let p = await q1<PixelRow>('select * from pixels where pixel_id = $1', [i.fb_pixel_id]);
    if (p) {
      const upd: Record<string, unknown> = {};
      if (i.capi_token) upd.capi_token = i.capi_token;
      if (i.test_event_code) upd.test_event_code = i.test_event_code;
      if (i.name) upd.name = i.name;
      if (Object.keys(upd).length) p = (await patchRow('pixels', p.id, upd)) as PixelRow;
    } else {
      p = await q1<PixelRow>(
        'insert into pixels (name, pixel_id, capi_token, test_event_code) values ($1,$2,$3,$4) returning *',
        [i.name ?? `Pixel ${i.fb_pixel_id}`, i.fb_pixel_id, i.capi_token ?? null, i.test_event_code ?? null],
      );
    }
    await patchRow('offers', o.id, { pixel_id: p!.id });
    clearOfferCache();
    const out = await mustOffer(o.id);
    return {
      offer: offerOut(out),
      note: p!.capi_token
        ? 'Пиксель привязан, CAPI включён.'
        : 'Пиксель привязан, но без capi_token: PageView/Contact уйдут из браузера, а Lead/Subscribe (они происходят в Telegram) в Meta не попадут.',
    };
  },
);

const FB_URL_TAGS =
  'utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}' +
  '&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&placement={{placement}}';

def(
  'get_offer_link',
  'Готовая ссылка для залива в Facebook Ads + параметры URL с макросами и проверка готовности оффера (что ещё не настроено).',
  { offer: offerKey },
  async ({ offer }) => {
    const o = await mustOffer(offer);
    const blocking: string[] = [];
    const warnings: string[] = [];
    if (o.status !== 'active') blocking.push('Оффер на паузе (status=paused) — лендинг отдаёт 404.');
    if (!o.channel) blocking.push('Не привязан канал (channel_id) — кнопке некуда вести.');
    else if (!o.bot) blocking.push('У канала нет бота — переподключите канал через add_channel.');
    if (o.landing_type === 'custom') {
      if (!o.landing_html) blocking.push('Выбран свой лендинг (custom), но HTML не загружен.');
      else if (ctaCount(o.landing_html) === 0)
        blocking.push('В своём HTML нет кнопки перехода: добавьте атрибут data-tg-link или href="{{tg_link}}".');
    }
    if (!o.pixel) blocking.push('Не привязан пиксель (attach_pixel).');
    else if (!o.pixel.capi_token)
      warnings.push('Нет capi_token: события Lead/Subscribe не попадут в Meta (они возникают в Telegram, не в браузере).');
    if (!o.welcome?.length) warnings.push('Приветственные сообщения не заданы.');
    const landing_url = `${landingBase(o)}/l/${o.slug}`;
    return {
      ready: blocking.length === 0,
      blocking_issues: blocking,
      warnings,
      landing_url,
      ad_url: `${landing_url}?${FB_URL_TAGS}`,
      url_tags: FB_URL_TAGS,
      how_to:
        'В Ads Manager: «Website URL» = landing_url, а поле «URL parameters» = url_tags (или вставьте ad_url целиком в Website URL).',
    };
  },
);

def(
  'test_capi',
  'Отправить тестовое событие Lead через CAPI (с test_event_code пикселя) — проверка токена и пикселя. Результат смотреть в Events Manager → Test Events.',
  { offer: offerKey },
  async ({ offer }) => {
    const o = await mustOffer(offer);
    if (!o.pixel) throw new HttpError(400, 'К офферу не привязан пиксель');
    if (!o.pixel.capi_token) throw new HttpError(400, 'У пикселя нет capi_token');
    if (!o.pixel.test_event_code)
      throw new HttpError(400, 'Задайте test_event_code пикселя (Events Manager → Test Events), иначе тест попадёт в боевые данные');
    const r = await sendCapi(o.pixel, {
      name: eventNameFor(o, 'join_request') ?? 'Lead',
      eventId: `test_${Date.now()}`,
      visit: { id: `test-${Date.now()}`, ip: '203.0.113.10', user_agent: 'fb-tg-crm test' },
      sourceUrl: `${landingBase(o)}/l/${o.slug}`,
      custom: { content_name: o.name },
      forceTest: true,
    });
    return r;
  },
);

// ───────────────────────── отчёты ─────────────────────────

const GROUPS: Record<string, string> = {
  none: `'all'`,
  day: `to_char(date_trunc('day', e.created_at at time zone $4::text), 'YYYY-MM-DD')`,
  utm_source: `coalesce(v.utm->>'utm_source', '(none)')`,
  utm_medium: `coalesce(v.utm->>'utm_medium', '(none)')`,
  utm_campaign: `coalesce(v.utm->>'utm_campaign', '(none)')`,
  utm_content: `coalesce(v.utm->>'utm_content', '(none)')`,
  utm_term: `coalesce(v.utm->>'utm_term', '(none)')`,
  campaign_id: `coalesce(v.params->>'campaign_id', '(none)')`,
  adset_id: `coalesce(v.params->>'adset_id', '(none)')`,
  ad_id: `coalesce(v.params->>'ad_id', '(none)')`,
  placement: `coalesce(v.params->>'placement', '(none)')`,
};

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 10000 : null);

function withRates(r: { views: number; clicks: number; join_requests: number; joined: number; left: number }) {
  return {
    ...r,
    click_rate: ratio(r.clicks, r.views), // клики / просмотры
    request_rate: ratio(r.join_requests, r.clicks), // заявки / клики
    join_rate: ratio(r.joined, r.views), // подписчики / просмотры
    click_to_join_rate: ratio(r.joined, r.clicks),
  };
}

def(
  'get_stats',
  'Воронка: просмотры → клики → заявки → подписчики (и отписки). Группировка по дню или по UTM/ID кампании/адсета/объявления/плейсменту. Считается по времени события.',
  {
    offer: offerKey.optional().describe('Без значения — по всем офферам'),
    from: z.string().datetime({ offset: true }).optional().describe('ISO-дата начала (по умолчанию −7 дней)'),
    to: z.string().datetime({ offset: true }).optional().describe('ISO-дата конца (по умолчанию сейчас)'),
    group_by: z.enum(Object.keys(GROUPS) as [string, ...string[]]).default('none'),
    tz: z.string().max(60).optional().describe('Часовой пояс для группировки по дням, напр. Asia/Ho_Chi_Minh'),
  },
  async (i) => {
    const o = i.offer ? await mustOffer(i.offer) : null;
    const to = i.to ?? new Date(Date.now() + 60_000).toISOString();
    const from = i.from ?? new Date(Date.now() - 7 * 86400_000).toISOString();
    // Часовой пояс: сначала проверяем и приводим к каноническому имени средствами Node,
    // затем убеждаемся, что его знает Postgres (браузеры шлют и старые алиасы вроде Asia/Saigon).
    let tz = i.tz ?? cfg.DEFAULT_TZ;
    try {
      tz = new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone;
    } catch {
      throw new HttpError(400, `Неизвестный часовой пояс: ${tz}`);
    }
    const params: unknown[] = [o?.id ?? null, from, to];
    if (i.group_by === 'day') {
      for (const candidate of [tz, cfg.DEFAULT_TZ, 'UTC']) {
        try {
          await q('select now() at time zone $1::text', [candidate]);
          tz = candidate;
          break;
        } catch {
          /* пробуем следующий */
        }
      }
      params.push(tz);
    }
    const rows = await q(
      `select ${GROUPS[i.group_by]} as key,
         count(*) filter (where e.type = 'page_view')     as views,
         count(*) filter (where e.type = 'click')         as clicks,
         count(*) filter (where e.type = 'join_request')  as join_requests,
         count(*) filter (where e.type = 'member_joined') as joined,
         count(*) filter (where e.type = 'left')          as "left"
       from events e left join visits v on v.id = e.visit_id
       where ($1::uuid is null or e.offer_id = $1::uuid) and e.created_at >= $2::timestamptz and e.created_at < $3::timestamptz
       group by 1 order by 1`,
      params,
    );
    const norm = rows.map((r: any) => ({
      key: r.key as string,
      ...withRates({
        views: Number(r.views),
        clicks: Number(r.clicks),
        join_requests: Number(r.join_requests),
        joined: Number(r.joined),
        left: Number(r.left),
      }),
    }));
    const sum = (k: 'views' | 'clicks' | 'join_requests' | 'joined' | 'left') =>
      norm.reduce((a, r) => a + (r as any)[k], 0);
    return {
      offer: o ? { id: o.id, slug: o.slug, name: o.name } : 'all',
      from,
      to,
      group_by: i.group_by,
      tz: i.group_by === 'day' ? tz : undefined,
      totals: withRates({
        views: sum('views'),
        clicks: sum('clicks'),
        join_requests: sum('join_requests'),
        joined: sum('joined'),
        left: sum('left'),
      }),
      rows: norm,
    };
  },
);

def(
  'list_subscribers',
  'Подписчики/заявки с источником (UTM, кампания, объявление).',
  {
    offer: offerKey.optional(),
    status: z.enum(['requested', 'member', 'left']).optional(),
    limit: z.number().int().min(1).max(500).default(50),
    offset: z.number().int().min(0).default(0),
  },
  async (i) => {
    const o = i.offer ? await mustOffer(i.offer) : null;
    return q(
      `select s.id, s.tg_user_id::text as tg_user_id, s.username, s.first_name, s.status,
              s.requested_at, s.joined_at, s.left_at, off.slug as offer, v.utm, v.params
       from subscribers s
       join offers off on off.id = s.offer_id
       left join visits v on v.id = s.visit_id
       where ($1::uuid is null or s.offer_id = $1::uuid) and ($2::text is null or s.status = $2::text)
       order by s.requested_at desc limit $3 offset $4`,
      [o?.id ?? null, i.status ?? null, i.limit, i.offset],
    );
  },
);

def(
  'recent_events',
  'Последние события воронки со статусом отправки в CAPI (для отладки).',
  {
    offer: offerKey.optional(),
    type: z.enum(['page_view', 'click', 'join_request', 'member_joined', 'left']).optional(),
    limit: z.number().int().min(1).max(200).default(30),
  },
  async (i) => {
    const o = i.offer ? await mustOffer(i.offer) : null;
    return q(
      `select e.id, e.type, e.created_at, e.tg_user_id::text as tg_user_id, e.visit_id, e.meta, e.capi, off.slug as offer
       from events e left join offers off on off.id = e.offer_id
       where ($1::uuid is null or e.offer_id = $1::uuid) and ($2::text is null or e.type = $2::text)
       order by e.id desc limit $3`,
      [o?.id ?? null, i.type ?? null, i.limit],
    );
  },
);

export const opsByName = new Map(ops.map((o) => [o.name, o]));
