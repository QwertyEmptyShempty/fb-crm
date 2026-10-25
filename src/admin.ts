import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { cfg } from './config.js';
import {
  clearFailedLogins,
  cookieHeader,
  credentialsOk,
  loginThrottled,
  newSessionValue,
  registerFailedLogin,
  sessionOk,
} from './session.js';

const PUBLIC_DIR = new URL('../public/', import.meta.url);
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
};

async function sendFile(reply: import('fastify').FastifyReply, name: string) {
  try {
    const buf = await readFile(new URL(name, PUBLIC_DIR));
    return reply
      .header('content-type', TYPES[name.split('.').pop()!] ?? 'application/octet-stream')
      .header('cache-control', 'no-cache')
      .header('x-frame-options', 'DENY')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .send(buf);
  } catch {
    return reply.code(404).send('Not found');
  }
}

export function registerAdmin(app: FastifyInstance) {
  // Статика панели
  app.get('/admin', (_req, reply) => sendFile(reply, 'index.html'));
  app.get('/admin/', (_req, reply) => sendFile(reply, 'index.html'));
  app.get<{ Params: { file: string } }>('/admin/assets/:file', (req, reply) => {
    if (!/^[a-z0-9._-]+$/i.test(req.params.file)) return reply.code(404).send();
    return sendFile(reply, req.params.file);
  });

  // Вход / выход
  app.post<{ Body: { login?: string; password?: string } }>('/admin/login', async (req, reply) => {
    const ip = req.ip;
    if (loginThrottled(ip)) {
      return reply.code(429).send({ error: 'Слишком много попыток. Подождите 10 минут.' });
    }
    const { login = '', password = '' } = req.body ?? {};
    if (typeof login !== 'string' || typeof password !== 'string' || !credentialsOk(login, password)) {
      registerFailedLogin(ip);
      return reply.code(401).send({ error: 'Неверный логин или пароль' });
    }
    clearFailedLogins(ip);
    reply.header('set-cookie', cookieHeader(newSessionValue()));
    return { ok: true, login: cfg.ADMIN_LOGIN };
  });

  app.post('/admin/logout', async (_req, reply) => {
    reply.header('set-cookie', cookieHeader(null));
    return { ok: true };
  });

  app.get('/admin/me', async (req, reply) => {
    if (!sessionOk(req)) return reply.code(401).send({ error: 'Нужно войти' });
    return { ok: true, login: cfg.ADMIN_LOGIN };
  });
}
