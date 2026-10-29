const $ = (s) => document.querySelector(s);
let key = null;
try { key = localStorage.getItem('k'); } catch {}

let items = [];
try { items = JSON.parse(localStorage.getItem('items') || '[]'); } catch {}
let busy = false;    // editing or dragging: hold off re-rendering
let pending = false; // a server update arrived while busy

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) return showNoKey();
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function setItems(next) {
  items = next;
  try { localStorage.setItem('items', JSON.stringify(items)); } catch {}
  if (busy) pending = true; else render();
}

function render() {
  pending = false;
  const active = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  $('#active').replaceChildren(...active.map(row));
  $('#done').replaceChildren(...done.map(row));
  $('#empty').hidden = active.length > 0;
  $('#doneTitle').hidden = done.length === 0;
}

function row(item) {
  const li = document.createElement('li');
  li.dataset.id = item.id;
  if (item.done) li.className = 'done';
  li.innerHTML = `${item.done ? '' : '<span class="handle" aria-label="Draga">⋮⋮</span>'}
    <button class="check" aria-label="${item.done ? 'Taka af' : 'Klára'}"><span>${item.done ? '✓' : ''}</span></button>
    <span class="text"></span>
    <button class="del" aria-label="Eyða" title="Eyða">×</button>`;
  li.querySelector('.text').textContent = item.text;
  return li;
}

// ---------- Actions ----------
$('#add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#text');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  setItems([{ id: 'tmp', text, done: false }, ...items]);
  try { await api('POST', '/api/items', { text }); } catch { input.value = text; }
});

document.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const id = li.dataset.id;
  const item = items.find((i) => i.id === id);
  if (!item) return;

  if (e.target.closest('.check')) {
    const done = !item.done;
    const rest = items.filter((i) => i !== item);
    const updated = { ...item, done };
    setItems(done ? [...rest.filter((i) => !i.done), updated, ...rest.filter((i) => i.done)] : [updated, ...rest]);
    api('PATCH', `/api/items/${id}`, { done });
  } else if (e.target.closest('.del')) {
    setItems(items.filter((i) => i !== item));
    api('DELETE', `/api/items/${id}`);
  } else if (e.target.closest('.text')) {
    startEdit(li, item);
  }
});

function startEdit(li, item) {
  const el = li.querySelector('.text');
  if (el.isContentEditable) return;
  busy = true;
  el.contentEditable = 'true';
  el.focus();
  const finish = (saveIt) => {
    el.removeEventListener('blur', onBlur);
    el.removeEventListener('keydown', onKey);
    el.contentEditable = 'false';
    busy = false;
    const text = el.textContent.trim();
    if (saveIt && text && text !== item.text) {
      item.text = text;
      api('PATCH', `/api/items/${item.id}`, { text });
    } else el.textContent = item.text;
    if (pending) render();
  };
  const onBlur = () => finish(true);
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { el.textContent = item.text; el.blur(); }
  };
  el.addEventListener('blur', onBlur);
  el.addEventListener('keydown', onKey);
}

// ---------- Drag to reorder (pointer events: works with touch and mouse) ----------
$('#active').addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.handle');
  if (!handle) return;
  e.preventDefault();
  const li = handle.closest('li');
  const list = li.parentElement;
  const grab = e.clientY - li.getBoundingClientRect().top;
  busy = true;
  li.classList.add('dragging');
  handle.setPointerCapture(e.pointerId);

  const move = (ev) => {
    li.style.transform = '';
    const others = [...list.children].filter((c) => c !== li);
    const before = others.find((c) => { const r = c.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
    list.insertBefore(li, before || null);
    li.style.transform = `translateY(${ev.clientY - grab - li.getBoundingClientRect().top}px)`;
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    li.style.transform = '';
    li.classList.remove('dragging');
    busy = false;
    const ids = [...list.children].map((c) => c.dataset.id);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    setItems([...ids.map((id) => byId[id]).filter(Boolean), ...items.filter((i) => i.done)]);
    api('POST', '/api/reorder', { ids });
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
});

// ---------- Live sync ----------
function connect() {
  const es = new EventSource(`/api/events?k=${encodeURIComponent(key)}`);
  es.onopen = () => { $('#status').hidden = true; };
  es.onmessage = (e) => setItems(JSON.parse(e.data).items);
  es.onerror = () => {
    $('#status').hidden = false;
    if (es.readyState === EventSource.CLOSED) { es.close(); setTimeout(connect, 3000); }
  };
}

// ---------- Push notifications ----------
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function currentSub() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
async function updateBell() {
  $('#bell').textContent = (await currentSub()) ? '🔔' : '🔕';
}
$('#bell').addEventListener('click', async () => {
  if (!pushSupported) { $('#hint').hidden = false; return; }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  } else {
    if ((await Notification.requestPermission()) !== 'granted') return alert('Tilkynningar eru ekki leyfðar á þessu tæki.');
    const { publicKey } = await api('GET', '/api/push/key');
    const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    await api('POST', '/api/push/subscribe', s.toJSON());
  }
  updateBell();
});
function b64ToBytes(s) {
  const b = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

// ---------- Boot ----------
function showNoKey() {
  $('#app').hidden = true;
  $('#bell').hidden = true;
  $('#nokey').hidden = false;
}

if (!key) showNoKey();
else {
  $('#app').hidden = false;
  render();
  connect();
  api('GET', '/api/me').catch(() => {}); // sets the long-lived cookie
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then(updateBell);
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (ios && !navigator.standalone) $('#hint').hidden = false;
}
