import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),
  DATABASE_SSL: bool.default('false'),
  // Публичный https-адрес сервиса (домен, который видят люди и Telegram)
  PUBLIC_URL: z
    .string()
    .url()
    .transform((s) => s.replace(/\/+$/, '')),
  // Вход в веб-панель (пока один пользователь)
  ADMIN_LOGIN: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(8, 'ADMIN_PASSWORD: минимум 8 символов'),
  // Базовый адрес лендингов по умолчанию (лучше отдельный домен, чем у панели). Если не задан — PUBLIC_URL.
  LANDING_URL: z
    .string()
    .url()
    .transform((s) => s.replace(/\/+$/, ''))
    .optional(),
  // Один или несколько ключей через запятую — для REST API и MCP
  API_KEYS: z
    .string()
    .min(16, 'API_KEYS: минимум 16 символов')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  // При старте заново выставлять вебхуки всех подключённых ботов (полезно при смене домена)
  TELEGRAM_SET_WEBHOOK: bool.default('true'),
  FB_API_VERSION: z.string().default('v23.0'),
  // Базовые адреса API (меняются только для локальных тестов с заглушками)
  TELEGRAM_API_BASE: z.string().url().default('https://api.telegram.org'),
  FB_GRAPH_BASE: z.string().url().default('https://graph.facebook.com'),
  // Подсказки по DNS: IP для A-записи корневого домена. Для Render по умолчанию 216.24.57.1.
  DNS_A_IP: z.string().ip().optional(),
  // Необязательно: автоматическое добавление доменов в Render через его API
  RENDER_API_KEY: z.string().min(10).optional(),
  RENDER_SERVICE_ID: z.string().min(5).optional(),
  RENDER_API_BASE: z.string().url().default('https://api.render.com/v1'),
  DEFAULT_TZ: z.string().default('UTC'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Ошибка конфигурации (.env):');
  for (const i of parsed.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}

export const cfg = parsed.data;
