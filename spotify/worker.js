/* Now-playing endpoint for alaskaoneheart.site, run as a Cloudflare Worker.
   It keeps the Spotify client secret and Pavel's refresh token, so the public site never sees them.
     GET /now        JSON for the site: { ok, playing, paused, last, song, artist, art, url, progress, duration, ago }
     GET /art/<id>   the cover from i.scdn.co, passed through for browsers that can't load Spotify's image host
     GET /           setup checklist
     GET /login      Spotify consent screen, which returns to /callback and prints the refresh token once
   Secrets (Worker > Settings > Variables and Secrets, type Secret): SPOTIFY_SECRET, SPOTIFY_REFRESH. */
const CLIENT_ID = '20d1ce15ffee4a9cb7741973e56bc01a';
const OWNER = '31dmdp75lwb7jyme324mqm5jiwhq';          // Pavel's Spotify user id: no other account can be connected
const SCOPE = 'user-read-currently-playing user-read-recently-played';
const FRESH = 5000;                                      // ms one Spotify answer is reused across visitors

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
let token = '', tokenExp = 0, cached = null, cachedAt = 0;

export default {
  async fetch(req, env) {
    const url = new URL(req.url), redirect = url.origin + '/callback';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/now') return now(env);
    if (url.pathname.startsWith('/art/')) return art(url.pathname.slice(5));
    if (url.pathname === '/login') return login(redirect);
    if (url.pathname === '/callback') return callback(req, url, env, redirect);
    return home(url, env, redirect);
  }
};

/* ---------- the site's endpoint ---------- */
async function now(env) {
  if (!env.SPOTIFY_SECRET || !env.SPOTIFY_REFRESH) return json({ ok: false, reason: 'setup' });
  if (!cached || Date.now() - cachedAt > FRESH) {
    try { cached = await read(env); } catch (e) { cached = { ok: false, reason: e.reason || 'error', message: e.message }; }
    cachedAt = Date.now();
  }
  const out = { ...cached }, t = Date.now();
  if (out.playing) out.progress = Math.min(out.duration || Infinity, out.progress + t - cachedAt);
  // ms since the track last played: the pause for a paused track, the end of play for the last one
  const at = out.paused ? out.changed_at : out.last ? Date.parse(out.played_at) : 0;
  if (at > 0 && at < t + 60000) out.ago = Math.max(0, t - at);
  return json(out);
}

async function read(env) {
  const cur = await api(env, '/me/player/currently-playing?additional_types=episode');
  if (cur && cur.item) return { ok: true, playing: !!cur.is_playing, paused: !cur.is_playing, ...track(cur.item), progress: cur.progress_ms || 0, changed_at: cur.timestamp || 0 };
  // nothing on right now: show the last track instead
  const rec = await api(env, '/me/player/recently-played?limit=1').catch(() => null);
  const it = rec && rec.items && rec.items[0];
  return it && it.track ? { ok: true, playing: false, last: true, ...track(it.track), played_at: it.played_at } : { ok: true, playing: false };
}

function track(it) {
  const imgs = (it.album && it.album.images) || it.images || (it.show && it.show.images) || [];
  const pic = imgs.filter(i => !i.width || i.width >= 160).sort((a, b) => (a.width || 0) - (b.width || 0))[0] || imgs[0];
  return {
    song: it.name || '',
    artist: it.artists ? it.artists.map(a => a.name).join(', ') : (it.show && it.show.name) || '',
    art: pic ? pic.url : '',
    url: (it.external_urls && it.external_urls.spotify) || '',
    duration: it.duration_ms || 0
  };
}

const fail = (reason, message) => Object.assign(new Error(message), { reason });

async function api(env, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch('https://api.spotify.com/v1' + path, { headers: { Authorization: 'Bearer ' + await access(env) } });
    if (r.status === 401 && !attempt) { token = ''; continue; }
    if (r.status === 204) return null;
    if (r.ok) return r.json();
    const j = await r.json().catch(() => ({})), msg = (j.error && j.error.message) || 'HTTP ' + r.status;
    // a lapsed Premium on the app owner's account turns every call into a 403
    if (r.status === 403) throw fail(/premium/i.test(msg) ? 'premium' : 'forbidden', msg);
    throw fail(r.status === 429 ? 'busy' : 'error', msg);
  }
  throw fail('auth', 'token refused');
}

async function access(env) {
  if (token && Date.now() < tokenExp) return token;
  const { ok, j } = await tokenCall(env, { grant_type: 'refresh_token', refresh_token: env.SPOTIFY_REFRESH.trim() });
  if (!ok) throw fail('auth', j.error_description || j.error || 'token refused');
  token = j.access_token;
  tokenExp = Date.now() + ((j.expires_in || 3600) - 60) * 1000;
  return token;
}

async function tokenCall(env, params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(CLIENT_ID + ':' + env.SPOTIFY_SECRET.trim()) },
    body: new URLSearchParams(params)
  });
  return { ok: r.ok, j: await r.json().catch(() => ({})) };
}

// covers only: the id is the hex name Spotify gives each image, so this can't be used to fetch anything else
async function art(id) {
  if (!/^[0-9a-f]{16,64}$/.test(id)) return new Response('bad id', { status: 400, headers: CORS });
  const r = await fetch('https://i.scdn.co/image/' + id, { cf: { cacheTtl: 604800, cacheEverything: true } });
  if (!r.ok) return new Response('no cover', { status: r.status, headers: CORS });
  return new Response(r.body, { headers: { ...CORS, 'Content-Type': r.headers.get('Content-Type') || 'image/jpeg', 'Cache-Control': 'public, max-age=604800, immutable' } });
}

const json = o => new Response(JSON.stringify(o), { headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

/* ---------- one-time setup ---------- */
function login(redirect) {
  const state = crypto.randomUUID();
  const q = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirect, scope: SCOPE, state, show_dialog: 'true' });
  return new Response(null, { status: 302, headers: { Location: 'https://accounts.spotify.com/authorize?' + q, 'Set-Cookie': `st=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax` } });
}

async function callback(req, url, env, redirect) {
  const again = '<p><a class="btn" href="/login">Подключить Spotify ещё раз</a></p>';
  if (url.searchParams.get('error')) return page('Spotify не дал доступ', `<p>Ответ Spotify: ${esc(url.searchParams.get('error'))}.</p>` + again);
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  const ck = /(?:^|;\s*)st=([^;]+)/.exec(req.headers.get('Cookie') || '');
  if (!code || !ck || ck[1] !== state) return page('Ссылка устарела', again);
  if (!env.SPOTIFY_SECRET) return page('Сначала секрет', '<p>Добавь секрет SPOTIFY_SECRET (шаг 1) и нажми Deploy.</p>');
  const { ok, j } = await tokenCall(env, { grant_type: 'authorization_code', code, redirect_uri: redirect });
  if (!ok) return page('Spotify отказал', `<p>${esc(j.error_description || j.error || 'неизвестная ошибка')}. Проверь, что SPOTIFY_SECRET вставлен целиком и Redirect URI совпадает с шагом 2.</p>` + again);
  const me = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: 'Bearer ' + j.access_token } });
  const mj = await me.json().catch(() => ({}));
  if (!me.ok) return page('Spotify не открыл профиль', `<p>${esc((mj.error && mj.error.message) || 'HTTP ' + me.status)}</p>` + again);
  if (mj.id !== OWNER) return page('Не тот аккаунт', `<p>Вошёл ${esc(mj.display_name || mj.id)}, а нужен аккаунт Павла.</p>` + again);
  return page('Последний шаг', `
    <p>Скопируй ключ и добавь его как ещё один секрет: <b>Settings → Variables and Secrets → Add</b>, тип <b>Secret</b>, имя <code>SPOTIFY_REFRESH</code>, значение — этот ключ. Потом <b>Deploy</b>.</p>
    <textarea id="k" readonly rows="4">${esc(j.refresh_token)}</textarea>
    <p><button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('k').value);this.textContent='Скопировано'">Скопировать ключ</button></p>
    <p class="dim">Ключ даёт только чтение того, что у тебя играет. Никому его не пересылай.</p>`);
}

function home(url, env, redirect) {
  const s = !!env.SPOTIFY_SECRET, r = !!env.SPOTIFY_REFRESH;
  const row = (done, body) => `<li class="${done ? 'ok' : ''}">${body}</li>`;
  return page(s && r ? 'Всё подключено' : 'Настройка', `
    <ol>
      ${row(s, 'Секрет <code>SPOTIFY_SECRET</code> (Client secret из Spotify) добавлен в <b>Settings → Variables and Secrets</b>')}
      ${row(false, `В Spotify Dashboard → твоё приложение → <b>Settings → Edit</b>: в <b>Redirect URIs</b> добавлен адрес <code id="ru">${esc(redirect)}</code> <button class="btn sm" onclick="navigator.clipboard.writeText(document.getElementById('ru').textContent);this.textContent='Скопировано'">Скопировать</button>, отмечен <b>Web API</b>, нажат <b>Save</b>`)}
      ${row(r, s ? `<a class="btn" href="/login">${r ? 'Подключить заново' : 'Подключить Spotify'}</a>` : 'Подключить Spotify (после шага 1)')}
      ${row(r, 'Секрет <code>SPOTIFY_REFRESH</code> добавлен')}
    </ol>
    ${s && r ? `<p>Адрес для сайта: <code>${esc(url.origin)}/now</code> · <a href="/now">проверить</a></p>` : ''}`);
}

const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body) {
  return new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title} · Spotify для alaskaoneheart.site</title><style>
body{margin:0;background:#e3132b;color:#111;font:16px/1.5 system-ui,sans-serif;padding:32px 16px}
main{max-width:620px;margin:auto;background:#fff;padding:24px;box-shadow:6px 6px 0 #111}
h1{margin:0 0 16px;font-size:24px;text-transform:uppercase}ol{padding-left:20px}li{margin:10px 0}li.ok::marker{content:"✓  ";color:#1a9b4b}
code{background:#f3eef0;padding:1px 5px;word-break:break-all}.btn{display:inline-block;background:#111;color:#fff;border:0;padding:10px 16px;font:inherit;cursor:pointer;text-decoration:none}
.btn:hover{background:#e3132b}.btn.sm{padding:3px 8px;font-size:13px}textarea{width:100%;box-sizing:border-box;font:13px monospace;padding:8px}.dim{color:#666;font-size:14px}
</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
