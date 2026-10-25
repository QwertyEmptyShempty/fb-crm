import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { q, q1 } from './db.js';
import { clientFor, TgError, type TgClient } from './telegram.js';
import {
  type BotRow,
  escapeHtml,
  getOfferFull,
  isUuid,
  recordEvent,
  type OfferFull,
  type VisitRow,
  type WelcomeStep,
} from './core.js';

interface SubRow {
  id: string;
  offer_id: string;
  visit_id: string | null;
  tg_user_id: string;
  username: string | null;
  first_name: string | null;
  status: 'requested' | 'member' | 'left';
}

const MEMBER_STATUSES = new Set(['member', 'administrator', 'creator']);
const isMember = (m: any) => MEMBER_STATUSES.has(m?.status) || (m?.status === 'restricted' && m?.is_member);

function fill(text: string, sub: { first_name?: string | null; username?: string | null }) {
  return text
    .replace(/\{first_name\}/g, escapeHtml(sub.first_name ?? ''))
    .replace(/\{username\}/g, escapeHtml(sub.username ? `@${sub.username}` : ''))
    .replace(/\{full_name\}/g, escapeHtml(sub.first_name ?? ''));
}

async function sendStep(
  client: TgClient,
  chatId: number | string,
  step: WelcomeStep,
  who: { first_name?: string | null; username?: string | null },
) {
  const text = fill(step.text, who);
  if (step.photo_url) await client.sendPhoto(chatId, step.photo_url, text, step.buttons);
  else await client.sendMessage(chatId, text, step.buttons);
}

// ─────────────────────── join request ───────────────────────

async function markJoined(sub: SubRow, offer: OfferFull, source: string) {
  const row = await q1<SubRow>(
    `update subscribers set status = 'member', joined_at = now(), left_at = null
     where id = $1 and status <> 'member' returning *`,
    [sub.id],
  );
  if (!row) return; // уже учтён (approve + chat_member не задваиваем)
  const visit = row.visit_id ? await q1<VisitRow>('select * from visits where id = $1', [row.visit_id]) : null;
  await recordEvent(offer, visit, 'member_joined', { tgUserId: row.tg_user_id, meta: { source } });
}

async function onJoinRequest(bot: BotRow, r: any) {
  const client = clientFor(bot.token);
  const link: string | undefined = r.invite_link?.invite_link;
  if (!link) return;
  const visit = await q1<VisitRow>('select * from visits where invite_link = $1', [link]);
  if (!visit) return; // чужая/ручная ссылка — заявку обрабатывает админ сам
  const offer = await getOfferFull(visit.offer_id);
  if (!offer || offer.bot?.id !== bot.id) return;

  const user = r.from;
  const sub = (await q1<SubRow>(
    `insert into subscribers (offer_id, visit_id, tg_user_id, username, first_name, status)
     values ($1,$2,$3,$4,$5,'requested')
     on conflict (offer_id, tg_user_id) do update
       set visit_id = excluded.visit_id, username = excluded.username, first_name = excluded.first_name,
           status = case when subscribers.status = 'member' then 'member' else 'requested' end,
           requested_at = now()
     returning *`,
    [offer.id, visit.id, user.id, user.username ?? null, user.first_name ?? null],
  ))!;

  await recordEvent(offer, visit, 'join_request', { tgUserId: user.id });

  // Приветствия. Нулевая задержка — сразу и ДО одобрения: пока заявка не обработана,
  // бот может писать пользователю через user_chat_id, даже если тот не нажимал Start.
  const dmChat = r.user_chat_id ?? user.id;
  const steps = offer.welcome ?? [];
  for (const step of steps) {
    if ((step.delay_sec ?? 0) <= 0) {
      try {
        await sendStep(client, dmChat, step, user);
      } catch (e) {
        await recordEvent(offer, visit, 'dm_failed' as any, {
          tgUserId: user.id,
          capi: false,
          meta: { error: (e as Error).message },
        }).catch(() => {});
      }
    } else {
      await q(
        `insert into scheduled_messages (subscriber_id, bot_id, tg_user_id, step, run_at)
         values ($1,$2,$3,$4::jsonb, now() + make_interval(secs => $5))`,
        [sub.id, bot.id, user.id, JSON.stringify(step), step.delay_sec],
      );
    }
  }

  if (offer.auto_approve) {
    try {
      await client.approveJoinRequest(r.chat.id, user.id);
      await markJoined(sub, offer, 'approve');
    } catch (e) {
      await recordEvent(offer, visit, 'approve_failed' as any, {
        tgUserId: user.id,
        capi: false,
        meta: { error: (e as Error).message },
      }).catch(() => {});
    }
  }
}

// ─────────────────────── chat_member ───────────────────────

async function onChatMember(bot: BotRow, u: any) {
  const ch = await q1<{ id: string }>('select id from channels where chat_id = $1 and bot_id = $2', [u.chat.id, bot.id]);
  if (!ch) return;
  const userId = u.new_chat_member?.user?.id;
  if (!userId) return;
  const was = isMember(u.old_chat_member);
  const now = isMember(u.new_chat_member);
  if (was === now) return;

  const sub = await q1<SubRow>(
    `select s.* from subscribers s join offers o on o.id = s.offer_id
     where o.channel_id = $1 and s.tg_user_id = $2 order by s.requested_at desc limit 1`,
    [ch.id, userId],
  );
  if (!sub) return; // зашёл мимо наших ссылок — не наш трафик
  const offer = await getOfferFull(sub.offer_id);
  if (!offer) return;

  if (now) {
    await markJoined(sub, offer, 'chat_member');
  } else if (sub.status === 'member') {
    const row = await q1<SubRow>(
      `update subscribers set status = 'left', left_at = now() where id = $1 and status = 'member' returning *`,
      [sub.id],
    );
    if (!row) return;
    const visit = row.visit_id ? await q1<VisitRow>('select * from visits where id = $1', [row.visit_id]) : null;
    await recordEvent(offer, visit, 'left', { tgUserId: userId, capi: false });
  }
}

// ─────────────────────── личные сообщения ───────────────────────

async function onMessage(bot: BotRow, m: any) {
  if (m.chat?.type !== 'private' || !m.from) return;
  // Пользователь написал боту (нажал Start) — теперь бот может писать ему сам:
  // повторяем недоставленные отложенные сообщения.
  await q(
    `update scheduled_messages set run_at = now(), attempts = 0, error = null
     where tg_user_id = $1 and bot_id = $2 and sent_at is null and error is not null`,
    [m.from.id, bot.id],
  );
}

export async function handleUpdate(bot: BotRow, u: any) {
  if (u.chat_join_request) return onJoinRequest(bot, u.chat_join_request);
  if (u.chat_member) return onChatMember(bot, u.chat_member);
  if (u.message) return onMessage(bot, u.message);
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function registerBot(app: FastifyInstance) {
  // Один вебхук на каждого бота: /tg/webhook/<bot uuid>, секрет у каждого свой
  app.post<{ Params: { botId: string } }>('/tg/webhook/:botId', async (req, reply) => {
    const bot = isUuid(req.params.botId)
      ? await q1<BotRow>('select * from bots where id = $1', [req.params.botId])
      : null;
    const given = String(req.headers['x-telegram-bot-api-secret-token'] ?? '');
    if (!bot || !safeEq(given, bot.webhook_secret)) return reply.code(401).send();
    // Отвечаем сразу, обрабатываем в фоне — Telegram не должен ждать и ретраить
    void handleUpdate(bot, req.body).catch((e) => req.log.error({ err: (e as Error).message }, 'update failed'));
    return reply.code(200).send({ ok: true });
  });
}

// ─────────────────────── отложенные сообщения ───────────────────────

let ticking = false;

async function tick(log: { error: (o: any, m?: string) => void }) {
  if (ticking) return;
  ticking = true;
  try {
    const due = await q<{ id: string; tg_user_id: string; step: WelcomeStep; subscriber_id: string; token: string }>(
      `with c as (
         select id from scheduled_messages
         where sent_at is null and attempts < 5 and run_at <= now()
         order by run_at limit 20 for update skip locked
       )
       update scheduled_messages m set attempts = m.attempts + 1
       from c, bots b where m.id = c.id and b.id = m.bot_id
       returning m.id, m.tg_user_id::text as tg_user_id, m.step, m.subscriber_id, b.token`,
    );
    for (const m of due) {
      const who = await q1<{ first_name: string | null; username: string | null }>(
        'select first_name, username from subscribers where id = $1',
        [m.subscriber_id],
      );
      try {
        await sendStep(clientFor(m.token), Number(m.tg_user_id), m.step, who ?? {});
        await q('update scheduled_messages set sent_at = now(), error = null where id = $1', [m.id]);
      } catch (e) {
        const err = e as TgError;
        // 403 — пользователь не запускал бота/заблокировал: не долбим, ждём его /start
        const fatal = err instanceof TgError && (err.code === 403 || err.code === 400);
        const wait = err instanceof TgError && err.retryAfter ? err.retryAfter : 30;
        await q(
          `update scheduled_messages set error = $2, attempts = case when $3 then 5 else attempts end,
             run_at = now() + make_interval(secs => $4) where id = $1`,
          [m.id, err.message.slice(0, 300), fatal, wait],
        );
        log.error({ err: err.message, id: m.id }, 'scheduled message failed');
      }
    }
  } finally {
    ticking = false;
  }
}

export function startScheduler(log: { error: (o: any, m?: string) => void }) {
  const t = setInterval(() => void tick(log).catch((e) => log.error({ err: e.message })), 5000);
  t.unref();
  return () => clearInterval(t);
}
