import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { z } from 'zod';
import { apiAuthOk } from './auth.js';
import { cfg } from './config.js';
import { HttpError } from './db.js';
import { getOfferFull, type OfferFull } from './core.js';
import { importLandingZip } from './landing-zip.js';
import { renderLanding } from './landing.js';
import { landingBase, landingHtmlSchema, landingSchema, landingTypeSchema, ops, opsByName } from './ops.js';
import { sessionOk } from './session.js';

export function errorToHttp(e: unknown): { status: number; body: { error: string; details?: unknown } } {
  if (e instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: 'Некорректные параметры',
        details: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
  }
  if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
  // ошибки самого Fastify (битый JSON, слишком большое тело и т.п.)
  const sc = (e as any)?.statusCode;
  if (typeof sc === 'number' && sc >= 400 && sc < 500) return { status: sc, body: { error: (e as Error).message } };
  return { status: 500, body: { error: 'Внутренняя ошибка сервера' } };
}

export function registerApi(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true }));

  app.register(
    async (api) => {
      // Доступ: API-ключ (нейросеть, скрипты) либо сессия панели.
      // Для сессии изменяющие запросы требуют заголовок X-Requested-With: crm (защита от CSRF).
      api.addHook('onRequest', async (req, reply) => {
        if (apiAuthOk(req)) return;
        if (!sessionOk(req)) return reply.code(401).send({ error: 'Нужен API-ключ или вход в панель' });
        if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'crm') {
          return reply.code(403).send({ error: 'Запрос отклонён' });
        }
      });

      // Загрузка ZIP лендинга: тело — сам архив (до 30 МБ)
      api.addContentTypeParser(
        ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
        { parseAs: 'buffer', bodyLimit: 30 * 1024 * 1024 },
        (_req, body, done) => done(null, body),
      );

      api.setErrorHandler((err, req, reply) => {
        const { status, body } = errorToHttp(err);
        if (status === 500) req.log.error(err);
        reply.code(status).send(body);
      });

      const run = (name: string, input: unknown) => opsByName.get(name)!.run(input);
      const withParams = (req: FastifyRequest, extra: Record<string, unknown> = {}) => ({
        ...((req.query as object) ?? {}),
        ...((req.body as object) ?? {}),
        ...((req.params as object) ?? {}),
        ...extra,
      });

      // Числовые query-параметры приходят строками
      const num = (v: unknown) => (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v);
      const numeric = (o: Record<string, any>, keys: string[]) => {
        for (const k of keys) if (k in o) o[k] = num(o[k]);
        return o;
      };

      // ── пиксели
      api.get('/pixels', async () => run('list_pixels', {}));
      api.post('/pixels', async (req, reply) => reply.code(201).send(await run('create_pixel', req.body)));
      api.patch('/pixels/:id', async (req) => run('update_pixel', withParams(req)));
      api.delete('/pixels/:id', async (req) => run('delete_pixel', withParams(req)));

      // ── боты
      api.get('/bots', async () => run('list_bots', {}));
      api.post('/bots', async (req, reply) => reply.code(201).send(await run('add_bot', req.body)));
      api.post('/bots/:bot/webhook', async (req) => run('refresh_webhook', withParams(req)));
      api.delete('/bots/:bot', async (req) => run('delete_bot', withParams(req)));

      // ── каналы
      api.get('/channels', async () => run('list_channels', {}));
      api.post('/channels', async (req, reply) => reply.code(201).send(await run('add_channel', req.body)));
      api.delete('/channels/:id', async (req) => run('delete_channel', withParams(req)));

      // ── офферы
      api.get('/offers', async (req) => run('list_offers', req.query));
      api.post('/offers', async (req, reply) => reply.code(201).send(await run('create_offer', req.body)));
      api.get('/offers/:offer', async (req) => run('get_offer', withParams(req)));
      api.patch('/offers/:offer', async (req) => run('update_offer', withParams(req)));
      api.put('/offers/:offer/pixel', async (req) => run('attach_pixel', withParams(req)));
      api.get('/offers/:offer/link', async (req) => run('get_offer_link', withParams(req)));
      api.post('/offers/:offer/test-capi', async (req) => run('test_capi', withParams(req)));

      api.delete('/offers/:offer', async (req) => run('delete_offer', withParams(req)));
      api.put<{ Params: { offer: string } }>('/offers/:offer/landing-zip', async (req) => {
        const o = await getOfferFull(req.params.offer);
        if (!o) throw new HttpError(404, 'Оффер не найден');
        if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Нужно тело запроса: ZIP-архив (Content-Type: application/zip)');
        return importLandingZip(o.id, req.body);
      });

      // Предпросмотр лендинга из несохранённых настроек редактора (без пикселя и трекинга)
      api.post('/landing/preview', async (req) => {
        const body = z
          .object({
            offer: z.string().optional(),
            name: z.string().max(100).optional(),
            landing_type: landingTypeSchema.optional(),
            landing: landingSchema.optional(),
            landing_html: landingHtmlSchema.nullable().optional(),
          })
          .parse(req.body ?? {});
        const base = body.offer ? await getOfferFull(body.offer) : null;
        const o = {
          ...(base ?? {}),
          id: base?.id ?? 'preview',
          slug: base?.slug ?? 'preview',
          name: body.name ?? base?.name ?? 'Предпросмотр',
          domain: base?.domain ?? null,
          has_assets: base?.has_assets ?? false,
          event_map: base?.event_map ?? {},
          landing_type: body.landing_type ?? base?.landing_type ?? 'default',
          landing: body.landing ?? base?.landing ?? {},
          landing_html: body.landing_html !== undefined ? body.landing_html : (base?.landing_html ?? null),
          pixel: null,
        } as unknown as OfferFull;
        return { html: renderLanding(o, { visitId: null, preview: true }) };
      });

      api.get('/meta', async () => ({
        public_url: cfg.PUBLIC_URL,
        mcp_url: `${cfg.PUBLIC_URL}/mcp`,
        landing_base: landingBase({ domain: null }),
        login: cfg.ADMIN_LOGIN,
      }));

      // ── отчёты
      api.get('/stats', async (req) => run('get_stats', req.query));
      api.get('/subscribers', async (req) =>
        run('list_subscribers', numeric({ ...(req.query as object) }, ['limit', 'offset'])),
      );
      api.get('/events', async (req) =>
        run('recent_events', numeric({ ...(req.query as object) }, ['limit'])),
      );

      // ── универсальный вызов любой операции (те же, что в MCP)
      api.get('/ops', async () => ops.map((o) => ({ name: o.name, description: o.description })));
      api.post<{ Params: { name: string } }>('/ops/:name', async (req, reply) => {
        const op = opsByName.get(req.params.name);
        if (!op) return reply.code(404).send({ error: `Нет операции ${req.params.name}` });
        return op.run(req.body ?? {});
      });
    },
    { prefix: '/api/v1' },
  );
}
