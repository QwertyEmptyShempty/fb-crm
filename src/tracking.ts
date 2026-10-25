import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { q, q1 } from './db.js';
import { clientFor } from './telegram.js';
import {
  assetCache,
  escapeHtml,
  fireCapiForEvent,
  getOfferByDomainCached,
  getOfferCached,
  getOfferFull,
  isUuid,
  recordEvent,
  type OfferFull,
  type VisitRow,
} from './core.js';
import { renderLanding } from './landing.js';

const BOT_UA = /facebookexternalhit|facebot|meta-externalagent|bot|crawler|spider|preview|headless/i;
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const PARAM_KEYS = ['campaign_id', 'adset_id', 'ad_id', 'placement', 'site_source_name'];

const clientIp = (req: FastifyRequest) =>
  (req.headers['cf-connecting-ip'] as string | undefined) ?? req.ip;

function pick(src: Record<string, unknown>, keys: string[]) {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string' && v) out[k] = v.slice(0, 300);
  }
  return out;
}

export function notFoundPage(text: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(text)}</title><body style="font-family:system-ui;background:#0f1115;color:#c9ced6;display:grid;place-items:center;height:100vh;margin:0"><p>${escapeHtml(text)}</p>`;
}

/** Показать лендинг оффера: записать визит и просмотр, отдать страницу. */
async function serveLanding(req: FastifyRequest, reply: FastifyReply, offer: OfferFull | null) {
  reply.header('cache-control', 'no-store');
  if (!offer || offer.status !== 'active') {
    return reply.code(404).type('text/html').send(notFoundPage('Страница не найдена'));
  }
  const ua = String(req.headers['user-agent'] ?? '');
  // краулеры Meta и прочие боты не считаются посетителями
  if (BOT_UA.test(ua)) return reply.type('text/html').send(renderLanding(offer, { visitId: null }));

  const id = randomUUID();
  const query = req.query as Record<string, unknown>;
  const fbclid = typeof query.fbclid === 'string' ? query.fbclid.slice(0, 500) : null;
  const url = `${req.protocol}://${req.host}${req.url}`.slice(0, 1500);
  await q(
    `insert into visits (id, offer_id, fbclid, ip, user_agent, referrer, url, utm, params)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
    [
      id,
      offer.id,
      fbclid,
      clientIp(req),
      ua.slice(0, 500),
      String(req.headers.referer ?? '').slice(0, 500) || null,
      url,
      JSON.stringify(pick(query, UTM_KEYS)),
      JSON.stringify(pick(query, PARAM_KEYS)),
    ],
  );
  // просмотр пишем сразу; в CAPI он уйдёт позже — когда браузер пришлёт fbp/fbc
  await recordEvent(offer, { id } as VisitRow, 'page_view', { capi: false });
  return reply.type('text/html').send(renderLanding(offer, { visitId: id }));
}

export function registerTracking(app: FastifyInstance, panelHost: string) {
  // ── Лендинг по slug ───────────────────────────────────────
  app.get<{ Params: { slug: string } }>('/l/:slug', async (req, reply) =>
    serveLanding(req, reply, await getOfferCached(req.params.slug)),
  );

  // ── Ресурсы ZIP-лендинга: /l/<slug>/a/<path> ──────────────
  app.get<{ Params: { slug: string; '*': string } }>('/l/:slug/a/*', async (req, reply) => {
    const offer = await getOfferCached(req.params.slug);
    const path = req.params['*'];
    if (!offer || !path) return reply.code(404).send();
    const key = `${offer.id}:${path}`;
    let hit = assetCache.get(key);
    if (hit === undefined || (hit && Date.now() - hit.at > 60_000)) {
      const row = await q1<{ content_type: string; data: Buffer }>(
        'select content_type, data from landing_assets where offer_id = $1 and path = $2',
        [offer.id, path],
      );
      hit = row ? { at: Date.now(), type: row.content_type, data: row.data } : null;
      if (assetCache.size > 200) assetCache.clear();
      assetCache.set(key, hit);
    }
    if (!hit) return reply.code(404).send();
    return reply
      .header('content-type', hit.type)
      .header('cache-control', 'public, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .send(hit.data);
  });

  // ── Корень: панель или лендинг по кастомному домену ───────
  app.get('/', async (req, reply) => {
    const host = req.hostname.toLowerCase();
    if (host === panelHost) return reply.redirect('/admin', 302);
    return serveLanding(req, reply, await getOfferByDomainCached(host));
  });

  // ── Beacon: fbp/fbc из браузера → серверный PageView в CAPI ─
  app.post<{ Params: { id: string } }>('/t/:id/ids', async (req, reply) => {
    const { id } = req.params;
    if (!isUuid(id)) return reply.code(204).send();
    let body: any = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    const clean = (v: unknown) => (typeof v === 'string' && v.length < 300 ? v : null);
    const visit = await q1<VisitRow>(
      `update visits set fbp = coalesce($2, fbp), fbc = coalesce($3, fbc) where id = $1 returning *`,
      [id, clean(body?.fbp), clean(body?.fbc)],
    );
    if (!visit) return reply.code(204).send();

    // Первый beacon «занимает» отправку PageView в CAPI (идемпотентно)
    const ev = await q1<{ id: string }>(
      `update events set capi = '{"pending":true}'::jsonb
       where id = (select id from events where visit_id = $1 and type = 'page_view' and capi is null order by id limit 1)
       returning id`,
      [id],
    );
    if (ev) {
      const offer = await getOfferFull(visit.offer_id);
      if (offer) void fireCapiForEvent(offer, visit, 'page_view', Number(ev.id)).catch(() => {});
    }
    return reply.code(204).send();
  });

  // ── Клик по кнопке → уникальная ссылка в канал ────────────
  app.get<{ Params: { id: string } }>('/go/:id', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { id } = req.params;
    if (!isUuid(id)) return reply.code(404).type('text/html').send(notFoundPage('Ссылка устарела'));

    const visit = await q1<VisitRow>('select * from visits where id = $1', [id]);
    if (!visit) return reply.code(404).type('text/html').send(notFoundPage('Ссылка устарела'));
    const offer = await getOfferFull(visit.offer_id);
    if (!offer || offer.status !== 'active' || !offer.channel || !offer.bot) {
      return reply.code(404).type('text/html').send(notFoundPage('Страница недоступна'));
    }

    // Повторный заход (обновили страницу) — тот же инвайт, без новых ссылок и событий
    if (visit.invite_link) return reply.redirect(visit.invite_link, 302);

    let link: string;
    try {
      link = (await clientFor(offer.bot.token).createJoinRequestLink(offer.channel.chat_id, `v_${id.slice(0, 8)}`)).invite_link;
    } catch (e) {
      req.log.error({ err: (e as Error).message }, 'createChatInviteLink failed');
      const fallback = offer.channel.username ? `https://t.me/${offer.channel.username}` : null;
      if (fallback) return reply.redirect(fallback, 302);
      return reply.code(502).type('text/html').send(notFoundPage('Не удалось получить ссылку, попробуйте позже'));
    }

    // Гонка двойного клика: побеждает первая записанная ссылка
    const won = await q1<VisitRow>(
      `update visits set invite_link = $2, clicked_at = now()
       where id = $1 and invite_link is null returning *`,
      [id, link],
    );
    if (!won) {
      const cur = await q1<VisitRow>('select * from visits where id = $1', [id]);
      return reply.redirect(cur?.invite_link ?? link, 302);
    }
    await recordEvent(offer, won, 'click');
    return reply.redirect(link, 302);
  });
}
