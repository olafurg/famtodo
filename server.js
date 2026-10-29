#!/usr/bin/env node
// Fam Todo: one shared family list. Zero framework, one dependency (web-push).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const STATIC = path.join(__dirname, 'public');

fs.mkdirSync(DATA, { recursive: true });
const file = (n) => path.join(DATA, n);

function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}
function writeJSON(name, obj) {
  const tmp = file(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file(name));
}

// devices.json is owned by the CLI (invite/revoke), so the server re-reads it when it changes.
let devCache = { mtime: 0, data: {} };
function devices() {
  try {
    const m = fs.statSync(file('devices.json')).mtimeMs;
    if (m !== devCache.mtime) devCache = { mtime: m, data: readJSON('devices.json', {}) };
  } catch { devCache = { mtime: 0, data: {} }; }
  return devCache.data;
}

// ---------- CLI ----------
const [cmd, ...args] = process.argv.slice(2);
if (cmd) {
  const devs = readJSON('devices.json', {});
  if (cmd === 'invite') {
    const name = args.join(' ').trim();
    if (!name) { console.error('Usage: node server.js invite <name>'); process.exit(1); }
    const key = crypto.randomBytes(18).toString('base64url');
    devs[key] = { name, createdAt: Date.now() };
    writeJSON('devices.json', devs);
    console.log(`${name}: ${PUBLIC_URL}/?k=${key}`);
  } else if (cmd === 'devices') {
    for (const [k, d] of Object.entries(devs)) console.log(`${d.name}\t${k}\t${new Date(d.createdAt).toISOString().slice(0, 10)}`);
  } else if (cmd === 'revoke') {
    const t = args.join(' ');
    let n = 0;
    for (const [k, d] of Object.entries(devs)) if (k === t || d.name === t) { delete devs[k]; n++; }
    writeJSON('devices.json', devs);
    console.log(`Revoked ${n} device(s).`);
  } else {
    console.log('Commands: invite <name> | devices | revoke <name|key>   (no command = start server)');
  }
  process.exit(0);
}

// ---------- State ----------
let vapid = readJSON('vapid.json', null);
if (!vapid) { vapid = webpush.generateVAPIDKeys(); writeJSON('vapid.json', vapid); }
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

const db = readJSON('db.json', { items: [], subs: {} });
const save = () => writeJSON('db.json', db);

function sorted() {
  const active = db.items.filter((i) => !i.done).sort((a, b) => a.pos - b.pos);
  const done = db.items.filter((i) => i.done).sort((a, b) => b.doneAt - a.doneAt);
  return [...active, ...done];
}
const topPos = () => Math.min(0, ...db.items.filter((i) => !i.done).map((i) => i.pos)) - 1;

// ---------- Live sync (SSE) ----------
const clients = new Set();
function broadcast() {
  const msg = `data: ${JSON.stringify({ items: sorted() })}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---------- Push ----------
async function notify(fromKey, body) {
  const payload = JSON.stringify({ title: 'Fam Todo', body });
  let dirty = false;
  await Promise.all(Object.entries(db.subs).map(async ([key, subs]) => {
    if (key === fromKey || !devices()[key]) return;
    for (const sub of [...subs]) {
      try { await webpush.sendNotification(sub, payload, { TTL: 3600 }); }
      catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          db.subs[key] = db.subs[key].filter((s) => s.endpoint !== sub.endpoint);
          dirty = true;
        } else console.error('push failed', e.statusCode || e.message);
      }
    }
  }));
  if (dirty) save();
}

// ---------- HTTP helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e5) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}
function authKey(req, url) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  if (req.headers['x-key']) return req.headers['x-key'];
  if (url.searchParams.get('k')) return url.searchParams.get('k');
  const m = /(?:^|;\s*)k=([^;]+)/.exec(req.headers.cookie || '');
  return m && decodeURIComponent(m[1]);
}
function serveStatic(res, p) {
  const fp = path.join(STATIC, path.normalize(p === '/' ? '/index.html' : p));
  if (!fp.startsWith(STATIC)) return send(res, 404, 'Not found');
  fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---------- Routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Manifest is dynamic so the Home Screen app opens with the device key (iOS gives installed apps separate storage).
  if (p === '/manifest.webmanifest') {
    const k = url.searchParams.get('k') || '';
    const start = k ? `/?k=${encodeURIComponent(k)}` : '/';
    return send(res, 200, JSON.stringify({
      name: 'Fam Todo', short_name: 'Fam Todo', lang: 'is', start_url: start, scope: '/', id: '/',
      display: 'standalone', background_color: '#f6f4ef', theme_color: '#2f6f4f',
      icons: [192, 512].map((s) => ({ src: `/icon-${s}.png`, sizes: `${s}x${s}`, type: 'image/png', purpose: 'any maskable' })),
    }), { 'Content-Type': 'application/manifest+json' });
  }
  if (!p.startsWith('/api/')) return serveStatic(res, p);

  const key = authKey(req, url);
  const dev = key && devices()[key];
  if (!dev) return send(res, 401, { error: 'Ógildur lykill' });
  const cookie = { 'Set-Cookie': `k=${encodeURIComponent(key)}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax` };

  try {
    if (p === '/api/me' && req.method === 'GET') return send(res, 200, { name: dev.name }, cookie);

    if (p === '/api/items' && req.method === 'GET') {
      if (url.searchParams.get('format') === 'text') {
        return send(res, 200, sorted().map((i) => `${i.done ? '[x]' : '[ ]'} ${i.text}  (${i.id})`).join('\n') + '\n');
      }
      return send(res, 200, { items: sorted() });
    }

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify({ items: sorted() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (p === '/api/items' && req.method === 'POST') {
      const { text } = await readBody(req);
      const t = String(text || '').trim().slice(0, 500);
      if (!t) return send(res, 400, { error: 'Texti vantar' });
      const item = { id: crypto.randomBytes(6).toString('hex'), text: t, done: false, pos: topPos(), doneAt: null, by: dev.name, createdAt: Date.now() };
      db.items.push(item);
      save(); broadcast();
      notify(key, `${dev.name} bætti við: ${t}`);
      return send(res, 201, item);
    }

    const m = /^\/api\/items\/([\w-]+)$/.exec(p);
    if (m) {
      const item = db.items.find((i) => i.id === m[1]);
      if (!item) return send(res, 404, { error: 'Fannst ekki' });
      if (req.method === 'DELETE') {
        db.items = db.items.filter((i) => i !== item);
        save(); broadcast();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'PATCH') {
        const b = await readBody(req);
        if (typeof b.text === 'string' && b.text.trim()) item.text = b.text.trim().slice(0, 500);
        if (typeof b.done === 'boolean' && b.done !== item.done) {
          item.done = b.done;
          if (b.done) { item.doneAt = Date.now(); notify(key, `${dev.name} kláraði: ${item.text}`); }
          else { item.doneAt = null; item.pos = topPos(); }
        }
        save(); broadcast();
        return send(res, 200, item);
      }
    }

    // Body: { ids: [...] } = active item ids in the desired order.
    if (p === '/api/reorder' && req.method === 'POST') {
      const { ids } = await readBody(req);
      if (!Array.isArray(ids)) return send(res, 400, { error: 'ids vantar' });
      ids.forEach((id, n) => { const it = db.items.find((i) => i.id === id && !i.done); if (it) it.pos = n; });
      save(); broadcast();
      return send(res, 200, { ok: true });
    }

    if (p === '/api/push/key' && req.method === 'GET') return send(res, 200, { publicKey: vapid.publicKey });
    if (p === '/api/push/subscribe' && req.method === 'POST') {
      const sub = await readBody(req);
      if (!sub || !sub.endpoint) return send(res, 400, { error: 'Vantar áskrift' });
      db.subs[key] = (db.subs[key] || []).filter((s) => s.endpoint !== sub.endpoint).concat(sub);
      save();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/push/unsubscribe' && req.method === 'POST') {
      const { endpoint } = await readBody(req);
      db.subs[key] = (db.subs[key] || []).filter((s) => s.endpoint !== endpoint);
      save();
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'Fannst ekki' });
  } catch (e) {
    send(res, 400, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => console.log(`Fam Todo on http://${HOST}:${PORT}  (public: ${PUBLIC_URL})`));
