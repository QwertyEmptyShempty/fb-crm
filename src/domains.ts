// Домены лендингов: реестр, инструкции по DNS, проверка, (необязательно) авто-добавление в Render.
import dns from 'node:dns/promises';
import { cfg } from './config.js';
import { q, q1, HttpError } from './db.js';

export interface DomainRow {
  id: string;
  host: string;
  status: 'pending' | 'active';
  render_domain_id: string | null;
  problem: string | null;
  last_check: DnsInfo | null;
  checked_at: string | null;
  created_at: string;
}

export interface DnsInfo {
  a: string[];
  cname: string[];
  https_ok: boolean;
  https_error?: string;
}

export const panelHost = new URL(cfg.PUBLIC_URL).hostname;
export const renderAuto = Boolean(cfg.RENDER_API_KEY && cfg.RENDER_SERVICE_ID);

/** Приводит ввод пользователя («https://Go.Example.com/») к хосту «go.example.com». */
export function normalizeHost(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

export const HOST_RE = /^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,}$/;

const SLD = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

/** Корневой («example.com») домен или поддомен («go.example.com»). */
export function splitHost(host: string): { apex: string; sub: string; isRoot: boolean } {
  const labels = host.split('.');
  const apexLen = labels.length >= 3 && labels[labels.length - 1].length === 2 && SLD.has(labels[labels.length - 2]) ? 3 : 2;
  const apex = labels.slice(-apexLen).join('.');
  const sub = labels.slice(0, -apexLen).join('.');
  return { apex, sub, isRoot: sub === '' };
}

let ipCache: { at: number; ips: string[] } | null = null;
/** IP-адреса, на которые должна указывать A-запись. */
export async function serverIps(): Promise<string[]> {
  if (cfg.DNS_A_IP) return [cfg.DNS_A_IP];
  if (panelHost.endsWith('.onrender.com')) return ['216.24.57.1'];
  if (ipCache && Date.now() - ipCache.at < 10 * 60_000) return ipCache.ips;
  const ips = await dns.resolve4(panelHost).catch(() => [] as string[]);
  ipCache = { at: Date.now(), ips };
  return ips;
}

export interface DnsRecord {
  type: 'A' | 'CNAME';
  name: string;
  value: string;
  note?: string;
}

/** Какие DNS-записи нужно создать у регистратора. */
export async function dnsInstructions(host: string): Promise<{ is_root: boolean; records: DnsRecord[]; tips: string[] }> {
  const { sub, isRoot } = splitHost(host);
  const ips = await serverIps();
  const records: DnsRecord[] = [];
  const tips: string[] = [];
  if (isRoot) {
    records.push({
      type: 'A',
      name: '@',
      value: ips[0] ?? panelHost,
      note: ips.length ? 'Для корня домена — A-запись (CNAME на корне большинство регистраторов не разрешает).' : 'IP не определён: укажите ALIAS/ANAME на ' + panelHost,
    });
    records.push({ type: 'CNAME', name: 'www', value: panelHost, note: 'Необязательно: чтобы работал адрес с www.' });
    tips.push('Если у регистратора есть тип записи ALIAS или ANAME — можно вместо A создать ALIAS на ' + panelHost + '.');
  } else {
    records.push({ type: 'CNAME', name: sub, value: panelHost });
  }
  tips.push('Удалите старые записи A, AAAA и CNAME для этого же имени (парковка регистратора) — они мешают.');
  tips.push('Если домен на Cloudflare: включите режим «DNS only» (серое облако), оранжевое облако ломает выпуск сертификата.');
  return { is_root: isRoot, records, tips };
}

const CLOUDFLARE_IP = /^(104\.(1[6-9]|2\d|3[01])|172\.(6[4-9]|7[01])|162\.15[89]|141\.101|188\.114|108\.162|173\.245|190\.93|197\.234|198\.41)\./;

/** Превращает результаты проверок в понятное объяснение (на русском). */
export function diagnose(info: DnsInfo, expectedIps: string[], host: string): { ok: boolean; problem: string | null } {
  if (info.https_ok) return { ok: true, problem: null };
  const pointsHere =
    info.cname.some((c) => c.replace(/\.$/, '') === panelHost) ||
    info.a.some((ip) => expectedIps.includes(ip));
  if (!info.a.length && !info.cname.length) {
    return {
      ok: false,
      problem: `DNS-записи для ${host} пока не найдены. Либо вы их ещё не создали, либо они не успели обновиться (до 24 часов, обычно 5–30 минут).`,
    };
  }
  if (info.a.some((ip) => CLOUDFLARE_IP.test(ip)) && !pointsHere) {
    return { ok: false, problem: 'Домен идёт через прокси Cloudflare (оранжевое облако). Переключите запись на «DNS only» (серое облако) и повторите проверку.' };
  }
  if (!pointsHere) {
    const where = [...info.cname, ...info.a].join(', ');
    const need = expectedIps.length ? `${expectedIps.join(', ')} (A) или ${panelHost} (CNAME)` : panelHost;
    return { ok: false, problem: `Домен указывает на ${where}, а должен на ${need}. Исправьте запись у регистратора и удалите лишние.` };
  }
  return {
    ok: false,
    problem: renderAuto
      ? 'DNS настроен верно. Ждём выпуск сертификата https — обычно до часа. Нажмите «Проверить» позже.'
      : 'DNS настроен верно, но https не отвечает. Проверьте, что домен добавлен в хостинге (Render → сервис → Settings → Custom Domains) и подтверждён; сертификат выпускается до часа.',
  };
}

async function probe(host: string): Promise<DnsInfo> {
  const [a, cname] = await Promise.all([
    dns.resolve4(host).catch(() => [] as string[]),
    dns.resolveCname(host).catch(() => [] as string[]),
  ]);
  let https_ok = false;
  let https_error: string | undefined;
  try {
    const r = await fetch(`https://${host}/health`, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
    const j = (await r.json().catch(() => null)) as { ok?: boolean } | null;
    https_ok = r.status === 200 && j?.ok === true;
    if (!https_ok) https_error = `HTTP ${r.status}`;
  } catch (e) {
    https_error = (e as any)?.cause?.code || (e as Error).message;
  }
  return { a, cname, https_ok, https_error };
}

// ───────────── Render API (необязательно) ─────────────

async function renderCall(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${cfg.RENDER_API_BASE}/services/${cfg.RENDER_SERVICE_ID}${path}`, {
    method,
    headers: { authorization: `Bearer ${cfg.RENDER_API_KEY}`, 'content-type': 'application/json', accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* не JSON */
  }
  if (!r.ok) throw new Error(json?.message || `Render API ${r.status}`);
  return json;
}

// ───────────── операции ─────────────

export async function getDomain(key: string): Promise<DomainRow> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(key);
  const row = await q1<DomainRow>(
    isUuid ? 'select * from domains where id = $1' : 'select * from domains where lower(host) = lower($1)',
    [isUuid ? key : normalizeHost(key)],
  );
  if (!row) throw new HttpError(404, 'Домен не найден');
  return row;
}

export async function ensureDomain(hostRaw: string): Promise<void> {
  const host = normalizeHost(hostRaw);
  if (host === panelHost) throw new HttpError(400, 'Это адрес самой панели — для лендинга нужен другой домен');
  await q('insert into domains (host) values ($1) on conflict do nothing', [host]);
}

export async function listDomains() {
  const rows = await q<DomainRow & { offers: { slug: string; name: string }[] }>(
    `select d.*, coalesce((select json_agg(json_build_object('slug', o.slug, 'name', o.name) order by o.name)
                           from offers o where lower(o.domain) = lower(d.host)), '[]') as offers
       from domains d order by d.created_at`,
  );
  const ips = await serverIps();
  return {
    panel_host: panelHost,
    auto_render: renderAuto,
    server_ip: ips[0] ?? null,
    domains: await Promise.all(
      rows.map(async (d) => ({
        id: d.id,
        host: d.host,
        status: d.status,
        problem: d.problem,
        checked_at: d.checked_at,
        created_at: d.created_at,
        url: `https://${d.host}/`,
        offers: d.offers,
        setup: await dnsInstructions(d.host),
      })),
    ),
  };
}

export async function addDomain(hostRaw: string) {
  const host = normalizeHost(hostRaw);
  if (!HOST_RE.test(host)) throw new HttpError(400, 'Введите домен вида go.example.com (без http:// и без пути)');
  if (host === panelHost) throw new HttpError(400, 'Это адрес самой панели — для лендинга нужен другой домен');
  if (host.endsWith('.onrender.com')) throw new HttpError(400, 'Домены onrender.com подключать не нужно — используйте свой домен');
  if (await q1('select 1 from domains where lower(host) = $1', [host])) throw new HttpError(409, `Домен ${host} уже добавлен`);
  let renderId: string | null = null;
  let renderError: string | null = null;
  if (renderAuto) {
    try {
      const r = await renderCall('POST', '/custom-domains', { name: host });
      renderId = r?.id ?? null;
    } catch (e) {
      renderError = (e as Error).message;
    }
  }
  await q('insert into domains (host, render_domain_id, problem) values ($1,$2,$3)', [
    host,
    renderId,
    renderError ? `Не удалось добавить в Render автоматически: ${renderError}. Добавьте домен вручную: Render → сервис → Settings → Custom Domains.` : null,
  ]);
  return { ...(await getDomainOut(host)), render_error: renderError };
}

async function getDomainOut(host: string) {
  const all = await listDomains();
  return all.domains.find((d) => d.host === host)!;
}

export async function checkDomain(key: string) {
  const d = await getDomain(key);
  if (renderAuto && d.render_domain_id && d.status !== 'active') {
    await renderCall('POST', `/custom-domains/${d.render_domain_id}/verify`).catch(() => {});
  }
  const info = await probe(d.host);
  const { ok, problem } = diagnose(info, await serverIps(), d.host);
  await q('update domains set status = $2, problem = $3, last_check = $4::jsonb, checked_at = now() where id = $1', [
    d.id,
    ok ? 'active' : 'pending',
    problem,
    JSON.stringify(info),
  ]);
  return getDomainOut(d.host);
}

export async function deleteDomain(key: string) {
  const d = await getDomain(key);
  const used = await q<{ name: string }>('select name from offers where lower(domain) = lower($1)', [d.host]);
  if (used.length) {
    throw new HttpError(409, `Домен используется в кампаниях: ${used.map((u) => u.name).join(', ')}. Сначала выберите в них другой домен.`);
  }
  if (renderAuto && d.render_domain_id) await renderCall('DELETE', `/custom-domains/${d.render_domain_id}`).catch(() => {});
  await q('delete from domains where id = $1', [d.id]);
  return { deleted: true, host: d.host };
}
