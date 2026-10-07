/* Live bits of alaskaoneheart.site, run as a Cloudflare Worker.
   It keeps the Spotify client secret and Pavel's refresh token, so the public site never sees them.
     GET  /now        JSON for the site: { ok, playing, paused, last, song, artist, art, url, id, isrc, progress, duration, ago }
     GET  /art/<id>   the cover from i.scdn.co, passed through for browsers that can't load Spotify's image host
     GET  /pv/<id>    the 30-second preview of a Spotify track (Deezer by ISRC, else Spotify's embed page), passed through with CORS
     GET  /ae         After Effects status: { ok, state: live | render | off | none, project, comp, layers, rq, elapsed, session, ago }
     POST /ae         heartbeat from Pavel's After Effects plugin (ae-plugin/ in the site repo)
     GET  /ae/hours   minutes After Effects was open, per day of Pavel's time (UTC+8): { ok, days: { 'YYYY-MM-DD': minutes } }
     GET  /           setup checklist
     GET  /login      Spotify consent screen, which returns to /callback and prints the refresh token once
   Secrets (Worker > Settings > Variables and Secrets, type Secret): SPOTIFY_SECRET, SPOTIFY_REFRESH.
   Binding (Worker > Settings > Bindings): a D1 database as DB, for the After Effects status. */
const CLIENT_ID = '20d1ce15ffee4a9cb7741973e56bc01a';
const OWNER = '31dmdp75lwb7jyme324mqm5jiwhq';          // Pavel's Spotify user id: no other account can be connected
const SCOPE = 'user-read-currently-playing user-read-recently-played';
const FRESH = 5000;                                      // ms one Spotify answer is reused across visitors

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Range' };
let token = '', tokenExp = 0, cached = null, cachedAt = 0;

export default {
  async fetch(req, env) {
    const url = new URL(req.url), redirect = url.origin + '/callback';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/now') return now(env);
    if (url.pathname.startsWith('/art/')) return art(url.pathname.slice(5));
    if (url.pathname.startsWith('/pv/')) return preview(req, url, url.pathname.slice(4));
    if (url.pathname === '/ae') return req.method === 'POST' ? aePost(req, env) : aeGet(env);
    if (url.pathname === '/ae/hours') return aeHours(env);
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

// What the Worker last saw on Pavel's player (kept in D1 when it is bound). Spotify sometimes names no track for a while even though
// music plays (an "unknown" playback type), and its listening history can lag by hours, so without this the plate jumped back to an old track.
let seen = null, seenSaved = 0;

async function read(env) {
  const cur = await api(env, '/me/player/currently-playing?additional_types=episode'), t = Date.now();
  if (cur && cur.item) {
    const out = { ok: true, playing: !!cur.is_playing, paused: !cur.is_playing, ...track(cur.item), progress: cur.progress_ms || 0, changed_at: cur.timestamp || 0 };
    await remember(env, out, t);
    return out;
  }
  const s = seen && t - seen.at < 60000 ? seen : (await recall(env)) || seen;
  // no track named, or a short "nothing playing" while music runs: keep the track it was playing until that track would end
  if (s && s.playing && !(cur && cur.is_playing === false)) {
    const progress = s.progress + (t - s.at);
    if (progress < s.track.duration + 5000) return { ok: true, playing: true, ...s.track, progress: Math.min(progress, s.track.duration), changed_at: s.changed_at };
  }
  // nothing on right now: the last track, whichever is newer of what the Worker saw and Spotify's history
  const rec = await api(env, '/me/player/recently-played?limit=1').catch(() => null);
  const it = rec && rec.items && rec.items[0];
  const end = !s ? 0 : s.playing ? Math.min(t, s.at + Math.max(0, s.track.duration - s.progress)) : s.changed_at || s.at;
  if (s && (!it || !it.track || end > Date.parse(it.played_at))) return { ok: true, playing: false, last: true, ...s.track, played_at: new Date(end).toISOString() };
  return it && it.track ? { ok: true, playing: false, last: true, ...track(it.track), played_at: it.played_at } : { ok: true, playing: false };
}

async function remember(env, o, t) {
  const changed = !seen || seen.track.id !== o.id || seen.playing !== o.playing;
  seen = { track: { song: o.song, artist: o.artist, art: o.art, url: o.url, id: o.id, isrc: o.isrc, duration: o.duration }, playing: o.playing, progress: o.progress, changed_at: o.changed_at, at: t };
  if (env.DB && (changed || t - seenSaved > 60000)) {
    seenSaved = t;
    try { await (await kv(env)).set('sp_seen', JSON.stringify(seen)); } catch (e) { /* the plate still works from memory */ }
  }
}

async function recall(env) {
  if (!env.DB) return null;
  try { const v = JSON.parse((await (await kv(env)).get('sp_seen')) || 'null'); if (v && v.track && (!seen || v.at > seen.at)) seen = v; return seen; } catch (e) { return null; }
}

function track(it) {
  const imgs = (it.album && it.album.images) || it.images || (it.show && it.show.images) || [];
  const pic = imgs.filter(i => !i.width || i.width >= 160).sort((a, b) => (a.width || 0) - (b.width || 0))[0] || imgs[0];
  return {
    song: it.name || '',
    artist: it.artists ? it.artists.map(a => a.name).join(', ') : (it.show && it.show.name) || '',
    art: pic ? pic.url : '',
    url: (it.external_urls && it.external_urls.spotify) || '',
    id: it.id || '',
    isrc: (it.external_ids && it.external_ids.isrc) || '',
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

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

/* ---------- 30-second previews ---------- */
// Spotify stopped giving preview links to new apps, so the same recording is looked up on Deezer by its ISRC,
// then on Spotify's embed page, then on Deezer by artist and title. Only these two preview hosts are ever fetched.
const PREVIEW_HOST = /^https:\/\/(cdn[a-z0-9-]*\.dzcdn\.net|p\.scdn\.co)\//;
const pvFound = new Map();                               // track id -> { src, at }; Deezer's links expire, so they're kept 10 minutes

async function preview(req, url, id) {
  if (!/^[A-Za-z0-9]{22}$/.test(id)) return new Response('bad id', { status: 400, headers: CORS });
  let hit = pvFound.get(id);
  if (!hit || Date.now() - hit.at > 600000) {
    const src = await findPreview(id, url.searchParams.get('isrc') || '', (url.searchParams.get('q') || '').slice(0, 200)).catch(() => '');
    pvFound.set(id, hit = { src, at: Date.now() });
    if (pvFound.size > 300) pvFound.delete(pvFound.keys().next().value);
  }
  if (!hit.src) return new Response('no preview', { status: 404, headers: CORS });
  const range = req.headers.get('Range');
  const a = await fetch(hit.src, { headers: range ? { Range: range } : {} });
  if (!a.ok) { pvFound.delete(id); return new Response('preview gone', { status: 502, headers: CORS }); }
  const out = new Headers(CORS);
  for (const k of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) { const v = a.headers.get(k); if (v) out.set(k, v); }
  if (!out.has('Content-Type')) out.set('Content-Type', 'audio/mpeg');
  out.set('Cache-Control', 'public, max-age=3600');
  return new Response(a.body, { status: a.status, headers: out });
}

async function findPreview(id, isrc, q) {
  const deezer = async path => { const j = await (await fetch('https://api.deezer.com/' + path)).json().catch(() => null); return j; };
  if (/^[A-Z0-9]{12}$/i.test(isrc)) {
    const j = await deezer('track/isrc:' + isrc.toUpperCase());
    if (j && PREVIEW_HOST.test(j.preview || '')) return j.preview;
  }
  const html = await (await fetch('https://open.spotify.com/embed/track/' + id, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' } })).text().catch(() => '');
  const m = /https:\/\/p\.scdn\.co\/mp3-preview\/[A-Za-z0-9]+(?:\?[^"'\\\s<]*)?/.exec(html);
  if (m) return m[0].replace(/&amp;/g, '&');
  // last resort: search Deezer by "artist - song", and only take a result that really is that song (a wrong clip is worse than none)
  const cut = q.indexOf(' - ');
  if (cut > 0) {
    const artists = q.slice(0, cut).split(/,\s*/), song = q.slice(cut + 3);
    for (const query of ['artist:"' + artists[0].replace(/"/g, '') + '" track:"' + song.replace(/"/g, '') + '"', artists[0] + ' ' + song]) {
      const j = await deezer('search?limit=8&q=' + encodeURIComponent(query));
      const hit = ((j && j.data) || []).find(t => PREVIEW_HOST.test(t.preview || '') && sameTrack(t, artists, song));
      if (hit) return hit.preview;
    }
  }
  return '';
}

// "Song (feat. X)" and "Song - Remastered 2011" both count as "song"
const plain = x => String(x || '').toLowerCase().replace(/[(\[].*?[)\]]/g, ' ').replace(/\s+-\s+.*$/, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const alike = (a, b) => !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a))));
const sameTrack = (t, artists, song) => alike(plain(t.title_short || t.title), plain(song)) && artists.some(a => alike(plain(a), plain(t.artist && t.artist.name)));

/* ---------- After Effects status ---------- */
// Pavel's AE plugin reports every 30 seconds while After Effects is open; quiet for LIVE ms means he closed it.
// The first plugin to report sets the token; to move the card to another computer, delete the row ae_token in the D1 console.
const LIVE = 75000;
// Every heartbeat also adds the time since the previous one to the day it fell on (rows h:YYYY-MM-DD, ms, Pavel's day in UTC+8),
// so the site can chart his hours in AE week by week. A silence longer than GAP (sleep, crash) is not counted.
const GAP = 120000, TZ = 8 * 3600e3, DAY = 864e5;
let tableReady = false, aeRec = null, aeRecAt = 0, hoursOut = null, hoursAt = 0;

async function kv(env) {
  if (!tableReady) { await env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run(); tableReady = true; }
  return {
    get: k => env.DB.prepare('SELECT v FROM kv WHERE k = ?1').bind(k).first('v'),
    set: (k, v) => env.DB.prepare('INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2').bind(k, v).run()
  };
}

const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

async function aePost(req, env) {
  if (!env.DB) return json({ ok: false, reason: 'setup' }, 503);
  let b;
  try { b = JSON.parse(await req.text()); } catch (e) { return json({ ok: false, reason: 'bad' }, 400); }
  const tok = String((b && b.t) || '');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(tok)) return json({ ok: false, reason: 'bad' }, 400);
  const store = await kv(env), saved = await store.get('ae_token');
  if (!saved) await store.set('ae_token', tok);
  else if (!same(saved, tok)) return json({ ok: false, reason: 'forbidden' }, 403);
  const now = Date.now(), str = (v, n) => String(v == null ? '' : v).slice(0, n), int = v => Math.max(0, Math.min(9999, v | 0));
  let since = +b.since || now;
  if (since > now + 60000 || since < now - 7 * 864e5) since = now;
  const rq = Array.isArray(b.rq) ? [int(b.rq[0]), int(b.rq[1])] : [0, 0];
  let prev = {};
  try { prev = JSON.parse((await store.get('ae')) || '{}') || {}; } catch (e) {}
  let from = 0;
  if (prev.at && !prev.quit && now - prev.at <= GAP && since <= prev.at) from = prev.at;    // the same session, beating steadily
  else if (since > (prev.at || 0)) from = Math.max(since, now - GAP);                        // a new session: count from its start
  for (let a = from; a && a < now;) {                                                         // split at Pavel's midnights
    const day = Math.floor((a + TZ) / DAY), b2 = Math.min(now, (day + 1) * DAY - TZ);
    await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + ?2')
      .bind('h:' + new Date(day * DAY).toISOString().slice(0, 10), Math.round(b2 - a)).run();
    a = b2;
  }
  aeRec = { project: str(b.project, 120), comp: str(b.comp, 120), layers: int(b.layers), rendering: !!b.rendering, rq, since, at: now, quit: !!b.quit };
  aeRecAt = now;
  await store.set('ae', JSON.stringify(aeRec));
  return json({ ok: true });
}

async function aeGet(env) {
  if (!env.DB) return json({ ok: false, reason: 'setup' });
  const t = Date.now();
  if (!aeRec || t - aeRecAt > 5000) {
    try { const v = await (await kv(env)).get('ae'); aeRec = v ? JSON.parse(v) : {}; aeRecAt = t; }
    catch (e) { return json({ ok: false, reason: 'error', message: e.message }); }
  }
  const r = aeRec;
  if (!r.at) return json({ ok: true, state: 'none' });
  const live = !r.quit && t - r.at < LIVE;
  const out = { ok: true, state: live ? (r.rendering ? 'render' : 'live') : 'off', project: r.project, comp: r.comp, layers: r.layers, rq: r.rq };
  if (live) out.elapsed = Math.max(0, t - r.since);
  else { out.ago = Math.max(0, t - r.at); out.session = Math.max(0, r.at - r.since); }
  return json(out);
}

async function aeHours(env) {
  if (!env.DB) return json({ ok: false, reason: 'setup' });
  const t = Date.now();
  if (!hoursOut || t - hoursAt > 60000) {
    try {
      await kv(env);
      const { results } = await env.DB.prepare("SELECT k, v FROM kv WHERE k LIKE 'h:%'").all();
      const days = {};
      for (const r of results || []) days[r.k.slice(2)] = Math.round(parseInt(r.v, 10) / 60000);
      hoursOut = { ok: true, days }; hoursAt = t;
    } catch (e) { return json({ ok: false, reason: 'error', message: e.message }); }
  }
  return json(hoursOut);
}

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

async function home(url, env, redirect) {
  const s = !!env.SPOTIFY_SECRET, r = !!env.SPOTIFY_REFRESH;
  const row = (done, body) => `<li class="${done ? 'ok' : ''}">${body}</li>`;
  // After Effects: is the database bound, and when did the plugin last report
  let ae = null;
  if (env.DB) { try { ae = JSON.parse((await (await kv(env)).get('ae')) || '{}'); } catch (e) { ae = { error: e.message }; } }
  const mins = ms => Math.round(ms / 60000);
  const aeLine = !env.DB ? 'В <b>Settings → Bindings → Add → D1 database</b> привязана база с именем переменной <code>DB</code>'
    : ae.error ? `База привязана, но не отвечает: ${esc(ae.error)}`
    : !ae.at ? 'База привязана. Осталось поставить плагин в After Effects и открыть AE'
    : `After Effects на связи: последний сигнал ${mins(Date.now() - ae.at)} мин назад${ae.project ? ', проект ' + esc(ae.project) : ''} · <a href="/ae">проверить</a>`;
  return page(s && r && ae && ae.at ? 'Всё подключено' : 'Настройка', `
    <ol>
      ${row(s, 'Секрет <code>SPOTIFY_SECRET</code> (Client secret из Spotify) добавлен в <b>Settings → Variables and Secrets</b>')}
      ${row(false, `В Spotify Dashboard → твоё приложение → <b>Settings → Edit</b>: в <b>Redirect URIs</b> добавлен адрес <code id="ru">${esc(redirect)}</code> <button class="btn sm" onclick="navigator.clipboard.writeText(document.getElementById('ru').textContent);this.textContent='Скопировано'">Скопировать</button>, отмечен <b>Web API</b>, нажат <b>Save</b>`)}
      ${row(r, s ? `<a class="btn" href="/login">${r ? 'Подключить заново' : 'Подключить Spotify'}</a>` : 'Подключить Spotify (после шага 1)')}
      ${row(r, 'Секрет <code>SPOTIFY_REFRESH</code> добавлен')}
    </ol>
    ${s && r ? `<p>Адрес для сайта: <code>${esc(url.origin)}/now</code> · <a href="/now">проверить</a></p>` : ''}
    <h2>After Effects</h2>
    <ol>${row(!!(ae && ae.at), aeLine)}</ol>`);
}

const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body) {
  return new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title} · воркер alaskaoneheart.site</title><style>
body{margin:0;background:#e3132b;color:#111;font:16px/1.5 system-ui,sans-serif;padding:32px 16px}
main{max-width:620px;margin:auto;background:#fff;padding:24px;box-shadow:6px 6px 0 #111}
h1{margin:0 0 16px;font-size:24px;text-transform:uppercase}h2{margin:24px 0 4px;font-size:17px;text-transform:uppercase}ol{padding-left:20px}li{margin:10px 0}li.ok::marker{content:"✓  ";color:#1a9b4b}
code{background:#f3eef0;padding:1px 5px;word-break:break-all}.btn{display:inline-block;background:#111;color:#fff;border:0;padding:10px 16px;font:inherit;cursor:pointer;text-decoration:none}
.btn:hover{background:#e3132b}.btn.sm{padding:3px 8px;font-size:13px}textarea{width:100%;box-sizing:border-box;font:13px monospace;padding:8px}.dim{color:#666;font-size:14px}
</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
