import { createHash } from 'node:crypto';
import { cfg } from './config.js';

export interface PixelRow {
  id: string;
  name: string;
  pixel_id: string;
  capi_token: string | null;
  test_event_code: string | null;
}

export interface VisitLike {
  id: string;
  fbclid?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  url?: string | null;
  created_at?: Date | string;
}

export interface CapiResult {
  ok: boolean;
  skipped?: string;
  status?: number;
  response?: unknown;
  error?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

export async function sendCapi(
  pixel: PixelRow | null,
  ev: {
    name: string;
    eventId: string;
    visit?: VisitLike | null;
    sourceUrl?: string | null;
    custom?: Record<string, unknown>;
    // отправить с test_event_code (только для проверки токена/пикселя)
    forceTest?: boolean;
  },
): Promise<CapiResult> {
  if (!pixel) return { ok: false, skipped: 'no_pixel' };
  if (!pixel.capi_token) return { ok: false, skipped: 'no_capi_token' };

  const v = ev.visit ?? null;
  const userData: Record<string, unknown> = {};
  if (v) {
    userData.external_id = [sha256(v.id)];
    if (v.ip) userData.client_ip_address = v.ip;
    if (v.user_agent) userData.client_user_agent = v.user_agent;
    if (v.fbp) userData.fbp = v.fbp;
    const fbc =
      v.fbc ||
      (v.fbclid
        ? `fb.1.${new Date(v.created_at ?? Date.now()).getTime()}.${v.fbclid}`
        : undefined);
    if (fbc) userData.fbc = fbc;
  }

  const payload: Record<string, unknown> = {
    data: [
      {
        event_name: ev.name,
        event_time: Math.floor(Date.now() / 1000),
        event_id: ev.eventId,
        action_source: 'website',
        event_source_url: ev.sourceUrl ?? v?.url ?? undefined,
        user_data: userData,
        custom_data: ev.custom,
      },
    ],
  };
  // Тестовый код уходит ТОЛЬКО при ручной проверке (test_capi): с ним Meta не использует событие для оптимизации.
  if (ev.forceTest && pixel.test_event_code) payload.test_event_code = pixel.test_event_code;

  try {
    const res = await fetch(
      `${cfg.FB_GRAPH_BASE.replace(/\/+$/, '')}/${cfg.FB_API_VERSION}/${pixel.pixel_id}/events?access_token=${encodeURIComponent(pixel.capi_token)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, response: body };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
