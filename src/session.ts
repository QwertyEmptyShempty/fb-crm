import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { cfg } from './config.js';

// Один владелец панели. Сессия — подписанная cookie без хранения на сервере;
// смена ADMIN_PASSWORD или API_KEYS автоматически разлогинивает всех.
const SECRET = createHash('sha256').update(`session:${cfg.ADMIN_PASSWORD}:${cfg.API_KEYS[0]}`).digest();
export const COOKIE = 'crm_session';
const TTL_SEC = 7 * 86400;

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const sign = (payload: string) => createHmac('sha256', SECRET).update(payload).digest('base64url');

const sha = (s: string) => createHash('sha256').update(s).digest();
export function credentialsOk(login: string, password: string): boolean {
  const a = timingSafeEqual(sha(login), sha(cfg.ADMIN_LOGIN));
  const b = timingSafeEqual(sha(password), sha(cfg.ADMIN_PASSWORD));
  return a && b;
}

export function newSessionValue(): string {
  const payload = b64(JSON.stringify({ u: cfg.ADMIN_LOGIN, exp: Math.floor(Date.now() / 1000) + TTL_SEC }));
  return `${payload}.${sign(payload)}`;
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionOk(req: FastifyRequest): boolean {
  const v = readCookie(req, COOKIE);
  if (!v) return false;
  const [payload, sig] = v.split('.');
  if (!payload || !sig) return false;
  const expect = sign(payload);
  if (sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

export function cookieHeader(value: string | null): string {
  const secure = cfg.PUBLIC_URL.startsWith('https://') ? '; Secure' : '';
  const base = `${COOKIE}=${value ?? ''}; Path=/; HttpOnly; SameSite=Strict${secure}`;
  return value ? `${base}; Max-Age=${TTL_SEC}` : `${base}; Max-Age=0`;
}

// Простейшая защита от перебора пароля: 8 попыток за 10 минут с одного IP
const attempts = new Map<string, { n: number; reset: number }>();
export function loginThrottled(ip: string): boolean {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset < now) return false;
  return a.n >= 8;
}
export function registerFailedLogin(ip: string) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset < now) attempts.set(ip, { n: 1, reset: now + 10 * 60_000 });
  else a.n++;
}
export function clearFailedLogins(ip: string) {
  attempts.delete(ip);
}
