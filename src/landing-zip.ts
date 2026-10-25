import { unzipSync } from 'fflate';
import { HttpError, withTx } from './db.js';
import { clearOfferCache } from './core.js';
import { ctaCount } from './landing.js';

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
};

const MAX_FILES = 400;
const MAX_TOTAL = 40 * 1024 * 1024;
const MAX_FILE = 15 * 1024 * 1024;

export const contentTypeFor = (path: string) => TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? null;

function cleanPath(name: string): string | null {
  const p = name.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!p || p.startsWith('/') || p.includes('\0')) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '')) return null;
  if (parts[0] === '__MACOSX' || parts.some((s) => s === '.DS_Store' || s.startsWith('._'))) return null;
  return parts.join('/');
}

/** Распаковать ZIP лендинга: index.html → offers.landing_html, остальное → landing_assets. */
export async function importLandingZip(offerId: string, buf: Uint8Array) {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new HttpError(400, 'Это не ZIP-архив');

  let count = 0;
  let total = 0;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(buf, {
      filter: (f) => {
        if (f.name.endsWith('/')) return false;
        count++;
        total += f.originalSize;
        if (count > MAX_FILES) throw new HttpError(400, `В архиве больше ${MAX_FILES} файлов`);
        if (total > MAX_TOTAL) throw new HttpError(400, 'Распакованный размер больше 40 МБ');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Не удалось распаковать ZIP (повреждён или защищён паролем)');
  }

  let files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(raw)) {
    const p = cleanPath(name);
    if (p) files.set(p, data);
  }

  // Если всё лежит в одной папке верхнего уровня — поднимаем содержимое на корень
  if (![...files.keys()].some((k) => k.toLowerCase() === 'index.html')) {
    const tops = new Set([...files.keys()].map((k) => k.split('/')[0]));
    if (tops.size === 1) {
      const top = [...tops][0]!;
      const lifted = new Map<string, Uint8Array>();
      for (const [k, v] of files) lifted.set(k.slice(top.length + 1), v);
      files = lifted;
    }
  }

  const indexKey = [...files.keys()].find((k) => k.toLowerCase() === 'index.html');
  if (!indexKey) throw new HttpError(400, 'В корне архива нет index.html');
  const html = Buffer.from(files.get(indexKey)!).toString('utf8');
  files.delete(indexKey);

  const skipped: string[] = [];
  const assets: { path: string; type: string; data: Uint8Array }[] = [];
  for (const [path, data] of files) {
    const type = contentTypeFor(path);
    if (!type) {
      skipped.push(path);
      continue;
    }
    if (data.length > MAX_FILE) {
      skipped.push(`${path} (больше 15 МБ)`);
      continue;
    }
    assets.push({ path, type, data });
  }

  await withTx(async (c) => {
    await c.query('delete from landing_assets where offer_id = $1', [offerId]);
    for (const a of assets) {
      await c.query('insert into landing_assets (offer_id, path, content_type, data) values ($1,$2,$3,$4)', [
        offerId,
        a.path,
        a.type,
        Buffer.from(a.data),
      ]);
    }
    await c.query(
      `update offers set landing_type = 'custom', landing_html = $2, updated_at = now() where id = $1`,
      [offerId, html],
    );
  });
  clearOfferCache();

  return {
    files: assets.length,
    bytes: assets.reduce((n, a) => n + a.data.length, 0),
    skipped,
    cta_found: ctaCount(html),
  };
}
