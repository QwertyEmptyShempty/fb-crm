import { cfg } from './config.js';

export class TgError extends Error {
  constructor(
    message: string,
    public code: number,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

type Buttons = { text: string; url: string }[] | undefined;

const markup = (buttons: Buttons) =>
  buttons?.length ? { reply_markup: { inline_keyboard: buttons.map((b) => [{ text: b.text, url: b.url }]) } } : {};

/** Клиент Bot API для одного бота (у нас боты подключаются пользователем по токену). */
export class TgClient {
  private base: string;

  constructor(token: string) {
    this.base = `${cfg.TELEGRAM_API_BASE.replace(/\/+$/, '')}/bot${token}`;
  }

  private async call<T = any>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json().catch(() => null);
    if (!json?.ok) {
      throw new TgError(
        json?.description ?? `Telegram HTTP ${res.status}`,
        json?.error_code ?? res.status,
        json?.parameters?.retry_after,
      );
    }
    return json.result as T;
  }

  me = () => this.call<{ id: number; username: string; first_name: string }>('getMe');
  getChat = (chatId: string | number) => this.call<any>('getChat', { chat_id: chatId });
  getChatMember = (chatId: string | number, userId: number) =>
    this.call<any>('getChatMember', { chat_id: chatId, user_id: userId });

  // Уникальная ссылка с заявкой на вступление: одна ссылка = один клик с лендинга
  createJoinRequestLink = (chatId: string | number, name: string) =>
    this.call<{ invite_link: string }>('createChatInviteLink', {
      chat_id: chatId,
      name: name.slice(0, 32),
      creates_join_request: true,
    });
  approveJoinRequest = (chatId: string | number, userId: number) =>
    this.call<boolean>('approveChatJoinRequest', { chat_id: chatId, user_id: userId });

  sendMessage = (chatId: number | string, text: string, buttons?: Buttons) =>
    this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...markup(buttons),
    });
  sendPhoto = (chatId: number | string, photo: string, caption: string, buttons?: Buttons) =>
    this.call('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...markup(buttons) });

  setWebhook = (url: string, secret: string) =>
    this.call('setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['chat_join_request', 'chat_member', 'message'],
    });
  deleteWebhook = () => this.call('deleteWebhook', { drop_pending_updates: false });
}

const clients = new Map<string, TgClient>();
export function clientFor(token: string): TgClient {
  let c = clients.get(token);
  if (!c) clients.set(token, (c = new TgClient(token)));
  return c;
}
