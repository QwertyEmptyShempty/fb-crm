import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { cfg } from './config.js';

const digest = (s: string) => createHash('sha256').update(s).digest();
const keyDigests = cfg.API_KEYS.map(digest);

/** Ключ из `Authorization: Bearer …` или `x-api-key`. */
export function apiAuthOk(req: FastifyRequest): boolean {
  const h = req.headers.authorization;
  const bearer = typeof h === 'string' && h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
  const xkey = typeof req.headers['x-api-key'] === 'string' ? (req.headers['x-api-key'] as string) : '';
  const given = bearer || xkey;
  if (!given) return false;
  const d = digest(given);
  // сравниваем со всеми ключами без раннего выхода
  let ok = false;
  for (const k of keyDigests) ok = timingSafeEqual(d, k) || ok;
  return ok;
}
