import Fastify from 'fastify';
import { cfg } from './config.js';
import { migrate, pool, q } from './db.js';
import { syncWebhook } from './ops.js';
import type { BotRow } from './core.js';
import { registerTracking } from './tracking.js';
import { registerBot, startScheduler } from './bot.js';
import { registerApi } from './api.js';
import { registerMcp } from './mcp.js';
import { registerAdmin } from './admin.js';

const app = Fastify({
  logger: true,
  trustProxy: true,
  bodyLimit: 1_000_000,
});

// JSON-парсер, который терпит пустое тело (POST /offers/x/test-capi с content-type: json и без body)
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  if (!body) return done(null, {});
  try {
    done(null, JSON.parse(body as string));
  } catch {
    const err: Error & { statusCode?: number } = new Error('Некорректный JSON в теле запроса');
    err.statusCode = 400;
    done(err, undefined);
  }
});

// Панель, API и MCP отвечают только на домене PUBLIC_URL. На доменах лендингов их нет —
// иначе скрипты чужого/кастомного лендинга оказались бы на одном origin с сессией панели.
const panelHost = new URL(cfg.PUBLIC_URL).hostname.toLowerCase();
const panelHosts = new Set([panelHost, ...(panelHost === 'localhost' ? ['127.0.0.1'] : [])]);
app.addHook('onRequest', async (req, reply) => {
  const u = req.url;
  if ((u.startsWith('/admin') || u.startsWith('/api/') || u === '/mcp') && !panelHosts.has(req.hostname.toLowerCase())) {
    return reply.code(404).type('text/plain').send('Not found');
  }
});

registerApi(app);
registerAdmin(app);
registerTracking(app, panelHost);
registerBot(app);
registerMcp(app);

async function main() {
  await migrate();

  if (cfg.TELEGRAM_SET_WEBHOOK) {
    // Боты подключаются пользователем; при старте пере-выставляем вебхуки (например, после смены домена)
    for (const bot of await q<BotRow>('select * from bots')) {
      const err = await syncWebhook(bot);
      if (err) app.log.error({ err, bot: bot.username }, 'Не удалось установить webhook');
      else app.log.info(`Webhook установлен для @${bot.username}`);
    }
  }

  const stopScheduler = startScheduler(app.log);
  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });

  const shutdown = async () => {
    stopScheduler();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
