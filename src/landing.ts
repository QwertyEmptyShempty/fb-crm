import { escapeHtml, eventNameFor, type OfferFull } from './core.js';

export interface RenderOpts {
  /** id визита; null — предпросмотр или краулер (без пикселя и трекинга) */
  visitId: string | null;
  preview?: boolean;
}

const jsString = (s: string) => JSON.stringify(s).replace(/</g, '\\u003c');
const CTA_SELECTOR = "[data-tg-link], a[href^='/go/']";

/** Сколько элементов-кнопок найдено в пользовательском HTML (для проверки в панели). */
export function ctaCount(html: string | null | undefined): number {
  if (!html) return 0;
  return (html.match(/data-tg-link|\{\{\s*tg_link\s*\}\}|href=(["'])#tg\1/g) ?? []).length;
}

function pixelBlock(o: OfferFull, visitId: string | null): string {
  const pixel = o.pixel?.pixel_id && /^\d+$/.test(o.pixel.pixel_id) ? o.pixel.pixel_id : null;
  if (!pixel || !visitId) return '';
  const pv = eventNameFor(o, 'page_view');
  return `<script>
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init',${jsString(pixel)});
${pv ? `fbq('track',${jsString(pv)},{},{eventID:${jsString('page_view_' + visitId)}});` : ''}
</script>
<noscript><img height="1" width="1" style="display:none" alt="" src="https://www.facebook.com/tr?id=${pixel}&ev=PageView&noscript=1"/></noscript>`;
}

function trackScript(o: OfferFull, visitId: string | null, anchorFix: boolean): string {
  if (!visitId) return '';
  const clickName = eventNameFor(o, 'click') ?? '';
  return `<script>
(function(){
  var vid=${jsString(visitId)}, clickName=${jsString(clickName)}, last='', go='/go/'+vid;
  function cookie(n){var m=document.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]*)'));return m?decodeURIComponent(m[1]):null}
  function send(){
    var body=JSON.stringify({fbp:cookie('_fbp'),fbc:cookie('_fbc')});
    if(body===last)return; last=body;
    try{navigator.sendBeacon('/t/'+vid+'/ids',new Blob([body],{type:'application/json'}))}
    catch(e){fetch('/t/'+vid+'/ids',{method:'POST',headers:{'content-type':'application/json'},body:body,keepalive:true})}
  }
  setTimeout(send,1200);
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')send()});
  document.querySelectorAll(${jsString(CTA_SELECTOR)}).forEach(function(el){
    if(el.tagName==='A'&&!el.getAttribute('href'))el.setAttribute('href',go);
    el.addEventListener('click',function(e){
      e.preventDefault();
      try{if(window.fbq&&clickName)fbq('track',clickName,{},{eventID:'click_'+vid})}catch(_){}
      send();
      setTimeout(function(){location.href=go},250);
    });
  });
  ${
    anchorFix
      ? `document.querySelectorAll('a[href^="#"]').forEach(function(a){a.addEventListener('click',function(e){var id=a.getAttribute('href').slice(1);var t=id&&document.getElementById(id);if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth'})}})});`
      : ''
  }
})();
</script>`;
}

// ───────────────────────── Default ─────────────────────────

export function renderDefault(o: OfferFull, opts: RenderOpts): string {
  const L = o.landing ?? {};
  const accent = /^#[0-9a-fA-F]{6}$/.test(L.accent ?? '') ? (L.accent as string) : '#2AABEE';
  const light = L.theme === 'light';
  const title = L.title || o.name;
  const button = L.button_text || 'Перейти в Telegram';
  const bullets: string[] = Array.isArray(L.bullets) ? L.bullets : [];
  const go = opts.visitId ? `/go/${opts.visitId}` : '#';
  const bg = light ? '#f4f6f8' : '#0f1115';
  const fg = light ? '#16202a' : '#e8eaed';
  const muted = light ? '#566371' : '#b4bac4';
  const tile = light ? '#0000000a' : '#ffffff0d';

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root{--accent:${accent}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:${fg};
    background:radial-gradient(1200px 600px at 50% -10%,color-mix(in srgb,var(--accent) ${light ? 18 : 28}%,${bg}),${bg} 70%)}
  .card{width:100%;max-width:420px;text-align:center}
  .avatar{width:104px;height:104px;border-radius:50%;object-fit:cover;margin:0 auto 14px;display:block}
  .count{display:inline-block;margin:0 0 16px;padding:5px 12px;border-radius:99px;background:${tile};font-size:13px;color:${muted}}
  .img{width:100%;max-height:260px;object-fit:cover;border-radius:18px;margin-bottom:22px}
  h1{font-size:28px;line-height:1.2;margin:0 0 12px}
  .sub{font-size:16px;line-height:1.5;color:${muted};margin:0 0 18px}
  .text{font-size:15px;line-height:1.55;color:${muted};margin:0 0 20px;white-space:pre-line}
  ul{list-style:none;padding:0;margin:0 0 26px;text-align:left}
  li{padding:10px 14px;margin-bottom:8px;border-radius:12px;background:${tile};font-size:15px}
  li::before{content:"✓";color:var(--accent);font-weight:700;margin-right:10px}
  .btn{display:block;padding:16px 20px;border-radius:14px;background:var(--accent);color:#fff;
    font-size:17px;font-weight:600;text-decoration:none}
  .btn:active{transform:scale(.98)}
  .foot{margin-top:18px;font-size:12px;color:${light ? '#7b8794' : '#7d8590'}}
</style>
${L.custom_css ? `<style>${String(L.custom_css).replace(/<\/style/gi, '<\\/style')}</style>` : ''}
${pixelBlock(o, opts.visitId)}
${L.head_html ?? ''}
</head>
<body>
<main class="card">
  ${L.avatar_url ? `<img class="avatar" src="${escapeHtml(L.avatar_url)}" alt="">` : ''}
  ${L.count_text ? `<div class="count">${escapeHtml(L.count_text)}</div>` : ''}
  ${L.image_url ? `<img class="img" src="${escapeHtml(L.image_url)}" alt="">` : ''}
  <h1>${escapeHtml(title)}</h1>
  ${L.subtitle ? `<p class="sub">${escapeHtml(L.subtitle)}</p>` : ''}
  ${L.text ? `<p class="text">${escapeHtml(L.text)}</p>` : ''}
  ${bullets.length ? `<ul>${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''}
  <a class="btn" data-tg-link href="${go}" rel="nofollow">${escapeHtml(button)}</a>
  ${L.footer ? `<div class="foot">${escapeHtml(L.footer)}</div>` : ''}
</main>
${L.body_html ?? ''}
${trackScript(o, opts.visitId, false)}
</body>
</html>`;
}

// ───────────────────────── Custom (свой HTML / ZIP) ─────────────────────────

function injectHead(html: string, chunk: string): string {
  if (!chunk) return html;
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], head[0] + chunk);
  const root = html.match(/<html[^>]*>/i);
  if (root) return html.replace(root[0], `${root[0]}<head>${chunk}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${chunk}</head><body>${html}</body></html>`;
}

function injectBodyEnd(html: string, chunk: string): string {
  if (!chunk) return html;
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i >= 0 ? html.slice(0, i) + chunk + html.slice(i) : html + chunk;
}

export function renderCustom(o: OfferFull, opts: RenderOpts): string {
  let html = o.landing_html ?? '';
  const vid = opts.visitId;
  const go = vid ? `/go/${vid}` : '#';
  html = html
    .replace(/\{\{\s*tg_link\s*\}\}/g, go)
    .replace(/\{\{\s*visit_id\s*\}\}/g, vid ?? '')
    .replace(/href=(["'])#tg\1/g, `href="${go}"`);
  const base = o.has_assets ? `<base href="/l/${o.slug}/a/">` : '';
  html = injectHead(html, base + pixelBlock(o, vid));
  html = injectBodyEnd(html, trackScript(o, vid, !!o.has_assets));
  return html;
}

export function renderLanding(o: OfferFull, opts: RenderOpts): string {
  return o.landing_type === 'custom' && o.landing_html ? renderCustom(o, opts) : renderDefault(o, opts);
}
