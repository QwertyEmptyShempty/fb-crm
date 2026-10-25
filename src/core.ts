import { q, q1 } from './db.js';
import { sendCapi, type PixelRow } from './capi.js';

export interface BotRow {
  id: string;
  name: string;
  token: string;
  username: string | null;
  tg_id: string | number;
  webhook_secret: string;
}

export interface ChannelRow {
  id: string;
  bot_id: string | null;
  name: string;
  chat_id: string | number;
  title: string | null;
  username: string | null;
}

export interface WelcomeStep {
  text: string;
  delay_sec: number;
  photo_url?: string;
  buttons?: { text: string; url: string }[];
}

export type EventType = 'page_view' | 'click' | 'join_request' | 'member_joined' | 'left';

export interface OfferFull {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'paused';
  pixel_id: string | null;
  channel_id: string | null;
  domain: string | null;
  landing_type: 'default' | 'custom';
  landing_html: string | null;
  has_assets: boolean;
  landing: Record<string, any>;
  welcome: WelcomeStep[];
  auto_approve: boolean;
  event_map: Partial<Record<EventType, string | null>>;
  created_at: string;
  pixel: PixelRow | null;
  channel: ChannelRow | null;
  bot: BotRow | null; // бот канала (токен наружу не отдаём)
}

export interface VisitRow {
  id: string;
  offer_id: string;
  fbclid: string | null;
  fbp: string | null;
  fbc: string | null;
  ip: string | null;
  user_agent: string | null;
  referrer: string | null;
  url: string | null;
  utm: Record<string, string>;
  params: Record<string, string>;
  invite_link: string | null;
  clicked_at: string | null;
  created_at: string;
}

// Имена стандартных событий Meta по умолчанию. В event_map оффера можно переопределить
// или отключить отправку (null).
export const DEFAULT_EVENT_MAP: Record<string, string> = {
  page_view: 'PageView',
  click: 'Contact',
  join_request: 'Lead',
  member_joined: 'Subscribe',
};

export const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const OFFER_SQL = `
  select o.*, to_jsonb(p.*) as pixel, to_jsonb(c.*) as channel, to_jsonb(b.*) as bot,
         exists(select 1 from landing_assets a where a.offer_id = o.id) as has_assets
  from offers o
  left join pixels p on p.id = o.pixel_id
  left join channels c on c.id = o.channel_id
  left join bots b on b.id = c.bot_id`;

/** Оффер по uuid или slug (вместе с пикселем и каналом). */
export async function getOfferFull(key: string): Promise<OfferFull | null> {
  const where = isUuid(key) ? 'o.id = $1' : 'o.slug = $1';
  return q1<OfferFull>(`${OFFER_SQL} where ${where}`, [key]);
}

export async function listOffersFull(status?: string): Promise<OfferFull[]> {
  if (status) return q<OfferFull>(`${OFFER_SQL} where o.status = $1 order by o.created_at desc`, [status]);
  return q<OfferFull>(`${OFFER_SQL} order by o.created_at desc`);
}

/** Оффер, привязанный к домену (кастомный домен лендинга). */
export async function getOfferByDomain(host: string): Promise<OfferFull | null> {
  return q1<OfferFull>(`${OFFER_SQL} where lower(o.domain) = lower($1)`, [host]);
}

// Короткий кэш для горячего пути (лендинг под трафиком рекламы)
const cache = new Map<string, { at: number; offer: OfferFull | null }>();
/** Ресурсы ZIP-лендингов (кэш в памяти). */
export const assetCache = new Map<string, { at: number; type: string; data: Buffer } | null>();

export const clearOfferCache = () => {
  cache.clear();
  domainCache.clear();
  assetCache.clear();
};
const domainCache = new Map<string, { at: number; offer: OfferFull | null }>();

export async function getOfferByDomainCached(host: string): Promise<OfferFull | null> {
  const hit = domainCache.get(host);
  if (hit && Date.now() - hit.at < 10_000) return hit.offer;
  const offer = await getOfferByDomain(host);
  domainCache.set(host, { at: Date.now(), offer });
  return offer;
}

export async function getOfferCached(slug: string): Promise<OfferFull | null> {
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < 10_000) return hit.offer;
  const offer = await getOfferFull(slug);
  cache.set(slug, { at: Date.now(), offer });
  return offer;
}

export const eventNameFor = (offer: OfferFull, type: EventType): string | null => {
  const map = { ...DEFAULT_EVENT_MAP, ...offer.event_map } as Record<string, string | null>;
  return map[type] || null;
};

/** Отправка события в Meta CAPI и сохранение результата в events.capi */
export async function fireCapiForEvent(
  offer: OfferFull,
  visit: VisitRow | null,
  type: EventType,
  eventRowId: number,
): Promise<void> {
  const name = eventNameFor(offer, type);
  if (!name || !visit) {
    await q('update events set capi = $2::jsonb where id = $1', [
      eventRowId,
      JSON.stringify({ ok: false, skipped: !name ? 'unmapped' : 'no_visit' }),
    ]).catch(() => {});
    return;
  }
  const result = await sendCapi(offer.pixel, {
    name,
    eventId: `${type}_${visit.id}`,
    visit,
    sourceUrl: visit.url,
    custom: { content_name: offer.name },
  });
  await q('update events set capi = $2::jsonb where id = $1', [
    eventRowId,
    JSON.stringify(result),
  ]).catch(() => {});
}

/** Записать событие воронки и (опционально) отправить его в CAPI. */
export async function recordEvent(
  offer: OfferFull,
  visit: VisitRow | null,
  type: EventType,
  opts: { tgUserId?: number | string; meta?: Record<string, unknown>; capi?: boolean } = {},
): Promise<number> {
  const row = await q1<{ id: string }>(
    `insert into events (offer_id, visit_id, type, tg_user_id, meta)
     values ($1, $2, $3, $4, $5::jsonb) returning id`,
    [offer.id, visit?.id ?? null, type, opts.tgUserId ?? null, JSON.stringify(opts.meta ?? {})],
  );
  const id = Number(row!.id);
  if (opts.capi !== false) {
    void fireCapiForEvent(offer, visit, type, id).catch(() => {});
  }
  return id;
}
