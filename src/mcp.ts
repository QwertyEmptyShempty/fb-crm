import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { apiAuthOk } from './auth.js';
import { errorToHttp } from './api.js';
import { MCP_HIDDEN, ops } from './ops.js';

const INSTRUCTIONS = `Трекер конверсии Facebook Ads → Telegram.
Типовой сценарий запуска:
1) add_bot — подключить бота по токену от @BotFather; затем add_channel — подключить канал (бот должен быть админом с правом приглашать).
2) create_offer — создать оффер: тексты лендинга (landing) или свой HTML (landing_type=custom + landing_html), приветствия (welcome), channel_id, при желании свой домен (domain).
3) attach_pixel — привязать пиксель Facebook (fb_pixel_id + capi_token).
4) test_capi — проверить токен (нужен test_event_code), затем get_offer_link — получить готовую ссылку и URL-параметры для Ads Manager.
5) get_stats / list_subscribers — смотреть воронку просмотры → клики → заявки → подписчики.`;

function buildServer(): McpServer {
  const server = new McpServer({ name: 'fb-tg-crm', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  for (const op of ops.filter((o) => !MCP_HIDDEN.has(o.name))) {
    server.registerTool(
      op.name,
      { description: op.description, inputSchema: op.shape },
      (async (args: unknown) => {
        try {
          const result = await op.run(args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
          const { body } = errorToHttp(e);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
          };
        }
      }) as any,
    );
  }
  return server;
}

export function registerMcp(app: FastifyInstance) {
  // Stateless Streamable HTTP: подключайте клиента по URL  https://<домен>/mcp  с заголовком Authorization: Bearer <API key>
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      if (!apiAuthOk(req)) return reply.code(401).send({ error: 'Нужен API-ключ' });
      if (req.method !== 'POST') {
        return reply
          .code(405)
          .header('allow', 'POST')
          .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
      }
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      reply.hijack();
      await transport.handleRequest(req.raw, reply.raw, req.body);
    },
  });
}
