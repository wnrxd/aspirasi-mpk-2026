/* Aspirasi Digital MPK Mahardika SMAN 1 Cipari — script.js
   Tanpa library. fetch langsung ke Supabase (PostgREST + GoTrue). */
(() => {
'use strict';

/* ============================================================
   C0. KONSTANTA — ganti tiga nilai di bawah ini
   ============================================================ */
const SUPABASE_URL = "https://zlgrvzhlnmehmxhidmuy.supabase.co";
const SUPABASE_KEY = "sb_publishable_qYyXngQuQCte0TnLSx-p9w_OXIO7p-H";    // anon / publishable key
const ADMIN_EMAIL  = "mpkaspirasismancip@gmail.com";

/* ============================================================
   UTIL
   ============================================================ */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function safeGet(key){
  try { return localStorage.getItem(key); } catch(_) { return memStore[key] ?? null; }
}
function safeSet(key, val){
  try { localStorage.setItem(key, val); } catch(_) { memStore[key] = val; }
}
const memStore = {};

function uuid(){
  try {
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch(_) {}
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function getClientId(){
  let id = safeGet('mpk_v3_client_id');
  if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    id = uuid();
    safeSet('mpk_v3_client_id', id);
  }
  return id;
}

function getVotedIds(){
  try { return JSON.parse(safeGet('mpk_v3_voted') || '[]'); } catch(_) { return []; }
}
function setVotedIds(arr){
  try { safeSet('mpk_v3_voted', JSON.stringify(arr.slice(-500))); } catch(_) {}
}
function markVoted(id){
  const arr = getVotedIds();
  if (!arr.includes(id)) { arr.push(id); setVotedIds(arr); }
}

const dfID = new Intl.DateTimeFormat('id-ID', { day:'numeric', month:'short', year:'numeric' });

// Gabungkan halaman baru tanpa duplikat (aspirasi baru bisa menggeser offset)
function dedupeById(oldItems, rows){
  const seen = new Set(oldItems.map(x => x.id));
  return oldItems.concat(rows.filter(x => !seen.has(x.id)));
}

/* ============================================================
   STATE
   ============================================================ */
const state = {
  tab: 'beranda',
  subTab: 'isi',
  lite: false,
  liteManual: null,
  muted: safeGet('mpk_v3_muted') === '1',
  admin: { active: false, token: null, refresh: null, expiresAt: 0 },
  events: [],
  eventsLoaded: false,
  listUmum: { items: [], offset: 0, hasMore: false, loading: false, inited: false, seq: 0 },
  filter: 'all', // filter status daftar umum
  listEvent: {}, // { [eventId]: {items, offset, hasMore, loading, loaded, open} }
  stats: { total: 0, selesai: 0 },
  voted: getVotedIds(),
  offline: false,
  tabBusy: false,
  introDone: false,
  statsCounted: false,
  scrollTop: { beranda: 0, aspirasi: 0, event: 0, tentang: 0 },
  clientId: getClientId(),
  refreshTimer: null,
  pointer: { x: 0.5, y: 0.5, active: false },
  parallax: { scroll: 0, tabShift: 0, tilX: 0, tilY: 0 },
  idleTimer: 0,
  lastInput: performance.now()
};

/* ============================================================
   TOAST
   ============================================================ */
const toastWrap = $('#toastWrap');
function toast(msg, opts = {}){
  // Pesan yang sama tidak ditumpuk: cukup satu toast aktif
  for (const t of toastWrap.children){ if (t.textContent === msg && !t.classList.contains('out')) return; }
  const el = document.createElement('div');
  el.className = 'toast' + (opts.err ? ' err' : '');
  el.textContent = msg;
  toastWrap.appendChild(el);
  while (toastWrap.children.length > 3) toastWrap.firstChild.remove();
  const ttl = opts.ttl || 3400;
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, ttl);
}

/* ============================================================
   API LAYER
   ============================================================ */
function authHeaders(){
  const h = { apikey: SUPABASE_KEY };
  if (state.admin.active && state.admin.token) {
    h.Authorization = 'Bearer ' + state.admin.token;
  }
  return h;
}

async function rawFetch(path, opts = {}){
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(SUPABASE_URL + path, { ...opts, signal: controller.signal });
    clearTimeout(to);
    return res;
  } catch(err){
    clearTimeout(to);
    throw err;
  }
}

// Kembalikan { ok, data, error, kind } supaya pemanggil bisa cek mudah.
async function api(path, opts = {}){
  const method = opts.method || 'GET';
  const headers = { ...authHeaders(), ...(opts.headers || {}) };
  if (method !== 'GET') headers['Content-Type'] = 'application/json';
  if (opts.body !== undefined && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);

  let res;
  try {
    res = await rawFetch(path, { method, headers, body: opts.body });
  } catch(_err){
    return { ok: false, kind: 'network', error: 'Tidak bisa terhubung ke server. Periksa koneksi lalu coba lagi.' };
  }

  // 401 saat admin: coba refresh sekali
  if (res.status === 401 && state.admin.active && opts.retry !== false){
    const ok = await tryRefreshAdmin();
    if (ok) return api(path, { ...opts, retry: false });
    forceAdminLogout('Sesi admin berakhir. Silakan masuk lagi.');
    return { ok: false, kind: 'auth', error: 'Sesi admin berakhir' };
  }

  let data = null;
  const text = await res.text();
  if (text){
    try { data = JSON.parse(text); } catch(_) { data = text; }
  }

  if (!res.ok){
    const msg = (data && (data.message || data.error_description || data.error)) || ('HTTP ' + res.status);
    console.error('[api]', path, res.status, data);
    return { ok: false, kind: 'http', status: res.status, error: msg, data };
  }

  // RPC mengembalikan { success:false, error } → lempar sebagai error
  if (data && typeof data === 'object' && data.success === false){
    return { ok: false, kind: 'business', error: data.error || 'Terjadi kesalahan', data };
  }

  return { ok: true, data };
}

/* ============================================================
   CACHE (SWR)
   ============================================================ */
function cacheSet(key, value){
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value })); } catch(_) {}
}
function cacheGet(key){
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj.v : null;
  } catch(_) { return null; }
}

/* ============================================================
   PREFETCH & PEMUATAN DATA
   ============================================================ */
const K = {
  stats:   'mpk_v32_stats',
  events:  'mpk_v32_events',
  listU:   'mpk_v32_list_umum_p1'
};

async function loadStats(){
  const cached = cacheGet(K.stats);
  if (cached) { state.stats = cached; renderStats(false); }

  const r = await api('/rest/v1/rpc/get_stats', { method: 'POST', body: {} });
  if (r.ok && r.data){
    state.stats = r.data;
    cacheSet(K.stats, r.data);
    setOffline(false);
    renderStats(true);
  } else if (!cached){
    setOffline(true);
  }
}

async function loadEvents(){
  const cached = cacheGet(K.events);
  if (cached){ state.events = cached; state.eventsLoaded = true; updateEventGate(); }

  const r = await api('/rest/v1/events?select=id,nama,locked&order=created_at.asc');
  if (r.ok && Array.isArray(r.data)){
    state.events = r.data;
    state.eventsLoaded = true;
    cacheSet(K.events, r.data);
    updateEventGate();
    if (state.tab === 'event') renderEventList();
    setOffline(false);
  } else if (!cached){
    setOffline(true);
  }
}

async function loadListUmumPage(offset, append){
  if (state.listUmum.loading && append) return;
  state.listUmum.loading = true;
  const my = state.listUmum.seq = (state.listUmum.seq | 0) + 1;
  const fq = state.filter !== 'all' ? '&status=eq.' + encodeURIComponent(state.filter) : '';
  const hiddenCol = state.admin.active ? ',hidden' : '';

  const url = `/rest/v1/aspirasi?select=id,created_at,isi,status,votes,event_id${hiddenCol}&event_id=is.null${fq}&order=created_at.desc,id.desc&limit=21&offset=${offset}`;
  const r = await api(url);
  if (my !== state.listUmum.seq) return; // ada permintaan yang lebih baru (mis. filter diganti)

  if (r.ok && Array.isArray(r.data)){
    const rows = r.data.slice(0, 20);
    const hasMore = r.data.length > 20;
    state.listUmum.items = append ? dedupeById(state.listUmum.items, rows) : rows;
    state.listUmum.offset = offset + rows.length;
    state.listUmum.hasMore = hasMore;
    state.listUmum.inited = true;
    if (offset === 0 && state.filter === 'all') cacheSet(K.listU, rows);
    renderListUmum();
    setOffline(false);
  } else {
    if (!state.listUmum.inited){
      const cached = state.filter === 'all' ? cacheGet(K.listU) : null;
      if (cached){
        state.listUmum.items = cached;
        state.listUmum.inited = true;
        state.listUmum.hasMore = false;
        renderListUmum();
        setOffline(true);
      } else {
        renderListUmumSkeleton();
        setOffline(true);
      }
    } else {
      setOffline(true);
    }
  }
  state.listUmum.loading = false;
}

async function loadListEventPage(eventId, offset, append){
  const bucket = state.listEvent[eventId] || (state.listEvent[eventId] = {
    items: [], offset: 0, hasMore: false, loading: false, loaded: false, open: false
  });
  if (bucket.loading) return;
  bucket.loading = true;
  if (!bucket.items.length) renderEventBody(eventId); // tampilkan skeleton selama memuat

  const hiddenCol = state.admin.active ? ',hidden' : '';
  const url = `/rest/v1/aspirasi?select=id,created_at,isi,status,votes,event_id${hiddenCol}&event_id=eq.${eventId}&order=created_at.desc,id.desc&limit=21&offset=${offset}`;
  const r = await api(url);
  if (r.ok && Array.isArray(r.data)){
    const rows = r.data.slice(0, 20);
    bucket.items = append ? dedupeById(bucket.items, rows) : rows;
    bucket.offset = offset + rows.length;
    bucket.hasMore = r.data.length > 20;
    bucket.loaded = true;
    bucket.error = false;
    bucket.loading = false; // harus mati sebelum render, kalau tidak event kosong tampil sebagai skeleton
    cacheSet('mpk_v32_list_event_' + eventId + '_p1', bucket.items);
    renderEventBody(eventId);
  } else {
    const cached = cacheGet('mpk_v32_list_event_' + eventId + '_p1');
    if (!bucket.loaded && cached){ bucket.items = cached; bucket.loaded = true; }
    bucket.loading = false;
    bucket.error = !bucket.items.length;
    renderEventBody(eventId); // jangan biarkan skeleton menggantung kalau gagal
  }
  bucket.loading = false;
}

/* ============================================================
   BACKGROUND: DOODLES + AURORA
   ============================================================ */
const DOODLE_SVGS = [
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10h12a6 6 0 0 1 6 6v22a5 5 0 0 0-5-5H6z"/><path d="M42 10H30a6 6 0 0 0-6 6v22a5 5 0 0 1 5-5h13z"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="30" width="32" height="6" rx="1.5"/><rect x="10" y="22" width="28" height="6" rx="1.5"/><rect x="13" y="14" width="22" height="6" rx="1.5"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 38l4-12L34 6l8 8-20 20z"/><path d="M14 26l8 8"/><path d="M34 6l8 8"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="18" width="40" height="12" rx="2"/><path d="M12 18v5M20 18v7M28 18v5M36 18v7"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M24 6a12 12 0 0 0-7 21.7V34h14v-6.3A12 12 0 0 0 24 6z"/><path d="M20 40h8M21 44h6"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M24 12L4 20l20 8 20-8z"/><path d="M12 24v8c0 3 5 6 12 6s12-3 12-6v-8"/><path d="M44 20v10"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6h18l10 10v26H10z"/><path d="M28 6v10h10"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M42 8L6 22l14 6 4 12z"/><path d="M20 28l22-20"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M24 4l6 14 14 1-10 10 3 14-13-7-13 7 3-14L4 19l14-1z"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="3"/><ellipse cx="24" cy="24" rx="18" ry="7"/><ellipse cx="24" cy="24" rx="18" ry="7" transform="rotate(60 24 24)"/><ellipse cx="24" cy="24" rx="18" ry="7" transform="rotate(120 24 24)"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="6" width="28" height="36" rx="3"/><rect x="15" y="11" width="18" height="7" rx="1"/><path d="M15 24h4M22 24h4M29 24h4M15 31h4M22 31h4M29 31h4M15 37h11"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="18"/><path d="M6 24h36M24 6c6 6 6 30 0 36M24 6c-6 6-6 30 0 36"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 34l18-18 10 10-8 8H8z"/><path d="M22 24l8 8"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M40 26c0 6-8 10-16 10-2 0-3 0-5-1l-9 5 2-8C7 30 6 28 6 26c0-6 8-12 18-12s16 6 16 12z"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 34L14 14l6 20M10 28h8"/><path d="M24 14h5a4 4 0 0 1 0 10h-5zM24 24h5a4 4 0 0 1 0 10h-5z"/><path d="M42 18a5 5 0 0 0-9 3c0 4 4 5 4 8a5 5 0 0 1-9 3"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16a8 8 0 1 1 12 7c-3 2-4 4-4 8"/><circle cx="24" cy="40" r="1.6" fill="currentColor"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M32 14L16 30a6 6 0 0 0 8 8l18-18a10 10 0 0 0-14-14L10 24a14 14 0 0 0 20 20"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 32l4-4 16-16 4 4-16 16z"/><path d="M14 32l-2 8 8-2"/><path d="M30 10l4 4"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 8l6 24M34 8l-6 24"/><circle cx="14" cy="10" r="2"/><circle cx="34" cy="10" r="2"/><path d="M18 32a8 8 0 0 0 12 0"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6h20M14 42h20M16 6c0 8 8 12 8 18s-8 10-8 18M32 6c0 8-8 12-8 18s8 10 8 18"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 8h20v10a10 10 0 0 1-20 0z"/><path d="M14 12H8a6 6 0 0 0 6 8M34 12h6a6 6 0 0 1-6 8"/><path d="M20 28h8v6h-8zM14 40h20"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="14" r="2"/><circle cx="12" cy="24" r="2"/><circle cx="12" cy="34" r="2"/><path d="M20 14h20M20 24h20M20 34h20"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M24 8v4M10 20h4M34 20h4M13 10l3 3M32 13l3-3"/><path d="M24 16a8 8 0 0 0-5 14v6h10v-6a8 8 0 0 0-5-14z"/></svg>',
  '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M24 8v22"/><circle cx="24" cy="40" r="1.6" fill="currentColor"/></svg>'
];

const DOODLE_PLACES = [
  { t:4,  l:5,  s:56, r:-14, layer:1, i:0 },
  { t:9,  l:80, s:42, r:10,  layer:0, i:2 },
  { t:16, l:26, s:28, r:22,  layer:2, i:8 },
  { t:22, l:60, s:66, r:-6,  layer:1, i:5 },
  { t:6,  l:44, s:30, r:12,  layer:0, i:14 },
  { t:30, l:12, s:44, r:-18, layer:1, i:1 },
  { t:36, l:88, s:34, r:6,   layer:2, i:6 },
  { t:42, l:34, s:70, r:-10, layer:0, i:9 },
  { t:48, l:8,  s:38, r:16,  layer:1, i:10 },
  { t:52, l:70, s:30, r:-22, layer:2, i:11 },
  { t:58, l:22, s:64, r:8,   layer:0, i:3 },
  { t:64, l:90, s:36, r:-14, layer:1, i:7 },
  { t:68, l:6,  s:44, r:18,  layer:2, i:12 },
  { t:74, l:48, s:26, r:-8,  layer:0, i:15 },
  { t:78, l:82, s:52, r:14,  layer:1, i:17 },
  { t:84, l:16, s:34, r:-20, layer:2, i:18 },
  { t:88, l:60, s:58, r:4,   layer:0, i:19 },
  { t:94, l:30, s:26, r:-16, layer:1, i:20 },
  { t:97, l:76, s:40, r:12,  layer:2, i:21 },
  { t:12, l:52, s:24, r:28,  layer:0, i:22 },
  { t:26, l:96, s:46, r:-4,  layer:1, i:23 },
  { t:34, l:44, s:22, r:18,  layer:2, i:4 },
  { t:44, l:64, s:32, r:-12, layer:0, i:13 },
  { t:54, l:40, s:54, r:22,  layer:1, i:16 },
  { t:62, l:2,  s:28, r:-6,  layer:2, i:0 },
  { t:70, l:56, s:38, r:16,  layer:0, i:1 },
  { t:80, l:4,  s:24, r:24,  layer:1, i:8 },
  { t:90, l:44, s:44, r:-14, layer:2, i:6 },
  { t:98, l:8,  s:32, r:10,  layer:0, i:11 },
  { t:2,  l:26, s:20, r:-24, layer:1, i:22 },
  { t:20, l:74, s:22, r:20,  layer:2, i:5 },
  { t:46, l:24, s:36, r:-10, layer:0, i:14 },
  { t:68, l:32, s:20, r:12,  layer:1, i:3 },
  { t:86, l:92, s:24, r:-18, layer:2, i:9 }
];

const doodlesEl = $('#doodles');
const doodleEls = [];

function buildDoodles(){
  doodlesEl.innerHTML = '';
  doodleEls.length = 0;
  const places = state.lite ? DOODLE_PLACES.slice(0, 14) : DOODLE_PLACES;
  places.forEach((p, idx) => {
    const el = document.createElement('div');
    el.className = 'dw';
    el.dataset.layer = String(p.layer);
    el.style.top = p.t + '%';
    el.style.left = p.l + '%';
    el.style.width = p.s + 'px';
    el.style.height = p.s + 'px';
    el.innerHTML = DOODLE_SVGS[p.i % DOODLE_SVGS.length];
    doodlesEl.appendChild(el);
    // data untuk loop
    const tilt = p.r;
    el._baseTilt = tilt;
    el._layer = p.layer;
    el._phase = idx * 1.37;
    el._size = p.s;
    el._topPct = p.t;
    el._leftPct = p.l;
    el._tx = 0; el._ty = 0;
    // Terapkan blur statis hanya untuk lapisan jauh
    if (p.layer === 0) el.style.filter = 'blur(0.6px)';
    doodleEls.push(el);
  });
}

/* Aurora aktif per tab */
function setAuroraTab(tab){
  $$('.aurora-preset').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
}

/* ============================================================
   LOOP BACKGROUND (rAF tunggal)
   ============================================================ */
let rafId = null;
let lastFrame = 0;
let auroraT = 0;

function loop(now){
  rafId = requestAnimationFrame(loop);
  const dt = Math.min(48, now - lastFrame || 16);
  lastFrame = now;

  // Update aurora drift
  auroraT += dt / 1000;
  const presets = $$('.aurora-preset.active span');
  presets.forEach((s, i) => {
    const k = i + 1;
    const x = Math.sin(auroraT * (0.14 / k) + i * 1.6) * (16 + k * 8);
    const y = Math.cos(auroraT * (0.12 / k) + i * 2.1) * (14 + k * 6);
    s.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  });

  // Idle: kalau sudah lama tak ada input, berkurang kecepatannya
  const idle = (now - state.lastInput) > 2200;
  const idleK = idle ? 0.55 : 1;

  // Parallax doodles
  const scroll = state.parallax.scroll;
  const px = state.parallax.tilX;
  const py = state.parallax.tilY;
  for (let i = 0; i < doodleEls.length; i++){
    const el = doodleEls[i];
    const layer = el._layer;
    const speedY = layer === 0 ? 0.05 : layer === 1 ? 0.14 : 0.24;
    const speedX = layer === 0 ? 0.06 : layer === 1 ? 0.16 : 0.28;
    const floatAmp = layer === 0 ? 3 : layer === 1 ? 6 : 9;
    const floatY = Math.sin((now / 1000) * (0.5 + layer * 0.2) + el._phase) * floatAmp * idleK;

    const targetY = -scroll * speedY + py * (layer === 2 ? 24 : layer === 1 ? 14 : 6) + floatY;
    const targetX = px * (layer === 2 ? 24 : layer === 1 ? 14 : 6) + state.parallax.tabShift * speedX * 10;

    el._ty += (targetY - el._ty) * 0.09;
    el._tx += (targetX - el._tx) * 0.09;

    const rot = el._baseTilt + Math.sin((now / 1000) * 0.3 + el._phase) * 4 + scroll * 0.02 * (layer + 1);
    el.style.transform = `translate3d(${el._tx}px, ${el._ty}px, 0) rotate(${rot}deg)`;
  }

  // Lanyard physics
  stepLanyard(dt);
}

/* ============================================================
   INTRO
   ============================================================ */
const introEl = $('#intro');

function armIntro(){
  const dismiss = () => {
    if (state.introDone) return;
    state.introDone = true;
    introEl.classList.add('out');
    document.body.classList.remove('intro-lock');
    $('#tabnav').removeAttribute('inert');
    $('#app').removeAttribute('inert');
    $('#settingsBtn').removeAttribute('inert');
    setTimeout(() => introEl.remove(), 700);
    // Mulai loop background
    if (!rafId) rafId = requestAnimationFrame(loop);
    // Animasi masuk panel beranda
    const p = $('#panel-beranda');
    p.classList.add('entering');
    setTimeout(() => p.classList.remove('entering'), 800);
    // Trigger count-up stats
    maybeCountStats();
  };
  introEl.addEventListener('click', dismiss);
  introEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dismiss(); }
  });
}

/* ============================================================
   STATS COUNT-UP
   ============================================================ */
function renderStats(animate){
  const total = state.stats.total | 0;
  const selesai = state.stats.selesai | 0;
  const elT = $('#statTotal'), elS = $('#statSelesai');
  elT.dataset.target = total; elS.dataset.target = selesai;
  if (!animate || state.statsCounted) {
    elT.textContent = String(total);
    elS.textContent = String(selesai);
  } else {
    maybeCountStats();
  }
}

function countTo(el, target, dur = 900){
  const start = performance.now();
  const from = 0;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const ease = 1 - Math.pow(1 - t, 3);
    el.textContent = String(Math.round(from + (target - from) * ease));
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = String(target);
  };
  requestAnimationFrame(step);
}

function maybeCountStats(){
  if (state.statsCounted) return;
  const s = $('#stats');
  if (!s) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting){
        state.statsCounted = true;
        countTo($('#statTotal'), state.stats.total | 0);
        countTo($('#statSelesai'), state.stats.selesai | 0);
        io.disconnect();
      }
    });
  }, { threshold: 0.4 });
  io.observe(s);
}

/* ============================================================
   LANYARD DRAG
   ============================================================ */
const idcard = $('#idcard');
const lanyard = $('#lanyard');
let lanAngle = 12, lanVel = 0, lanDragging = false, lanStartX = 0, lanStartAngle = 0;

function applyLanyard(){
  if (!lanyard) return;
  lanyard.style.transform = `rotate(${lanAngle}deg)`;
}

function stepLanyard(dt){
  if (!idcard) return;
  if (!lanDragging){
    // spring
    const k = 0.008;
    const damp = 0.94;
    lanVel += -lanAngle * k * (dt / 16);
    lanVel *= damp;
    lanAngle += lanVel * (dt / 16);
    if (Math.abs(lanAngle) < 0.02 && Math.abs(lanVel) < 0.02){ lanAngle = 0; lanVel = 0; }
    applyLanyard();
  }
}

function initLanyard(){
  if (!idcard) return;
  applyLanyard();

  idcard.addEventListener('pointerdown', (e) => {
    lanDragging = true;
    lanStartX = e.clientX;
    lanStartAngle = lanAngle;
    idcard.setPointerCapture(e.pointerId);
  });
  idcard.addEventListener('pointermove', (e) => {
    if (!lanDragging) return;
    const dx = e.clientX - lanStartX;
    lanAngle = lanStartAngle - dx * 0.35;
    lanAngle = Math.max(-55, Math.min(55, lanAngle));
    applyLanyard();
  });
  const end = (e) => {
    if (!lanDragging) return;
    lanDragging = false;
    lanVel = -lanAngle * 0.02;
    try { idcard.releasePointerCapture(e.pointerId); } catch(_) {}
  };
  idcard.addEventListener('pointerup', end);
  idcard.addEventListener('pointercancel', end);
  idcard.addEventListener('pointerleave', (e) => { if (lanDragging) end(e); });
}

/* ============================================================
   TAB ROUTING
   ============================================================ */
const TABS = ['beranda','aspirasi','event','tentang'];

function currentPanel(){ return $('#panel-' + state.tab); }

function isEventUnlocked(){
  if (state.admin.active) return true;
  return state.events.some(e => e.locked === false);
}

function updateEventGate(){
  const btn = $('#tabBtn-event');
  if (!btn) return;
  const unlocked = isEventUnlocked();
  const wasLocked = btn.classList.contains('locked');
  btn.classList.toggle('locked', !unlocked);
  if (unlocked && wasLocked){
    btn.classList.add('unlocked-now');
    setTimeout(() => btn.classList.remove('unlocked-now'), 800);
  }
  $('#btnAddEvent').hidden = !state.admin.active;
}

function setTab(tab, opts = {}){
  if (!TABS.includes(tab)) tab = 'beranda';
  if (state.tabBusy) return;
  if (tab === state.tab){ 
    syncTabs();
    return;
  }
  // Event terkunci & bukan admin → tolak
  if (tab === 'event' && !isEventUnlocked()){
    shakeEventTab();
    toast('Belum ada event yang dibuka pengurus MPK');
    if (opts.fromHash) location.hash = '#beranda';
    return;
  }

  state.tabBusy = true;
  const stage = $('#app');
  const oldP = currentPanel();
  const dir = TABS.indexOf(tab) > TABS.indexOf(state.tab) ? 1 : -1;

  // Simpan scroll lama
  state.scrollTop[state.tab] = window.scrollY || 0;

  // Set tinggi stage
  if (oldP){
    stage.style.height = oldP.offsetHeight + 'px';
    stage.classList.add('animating');
    oldP.style.setProperty('--dir', String(dir));
    oldP.classList.add('leaving');
  }

  state.tab = tab;

  setTimeout(() => {
    if (oldP){
      oldP.classList.remove('leaving');
      oldP.hidden = true;
      oldP.style.removeProperty('--dir');
    }
    const newP = currentPanel();
    newP.hidden = false;
    newP.classList.add('entering');
    // update tinggi stage ke tinggi baru
    stage.style.height = newP.offsetHeight + 'px';

    setAuroraTab(tab);
    syncTabs();

    // reset scroll
    window.scrollTo({ top: 0, behavior: 'auto' });

    // Tab-specific lazy load
    if (tab === 'aspirasi') ensureListUmum();
    if (tab === 'event') { ensureEvents(); renderEventList(); }

    setTimeout(() => {
      newP.classList.remove('entering');
      stage.classList.remove('animating');
      stage.style.height = '';
      state.tabBusy = false;
    }, 460);
  }, 260);

  // hash sync
  if (!opts.fromHash){
    const newHash = '#' + tab;
    if (location.hash !== newHash) history.replaceState(null, '', newHash);
  }

  // shift parallax
  state.parallax.tabShift = dir;
  setTimeout(() => { state.parallax.tabShift = 0; }, 600);
}

function syncTabs(){
  TABS.forEach(t => {
    const btn = $('#tabBtn-' + t);
    const on = t === state.tab;
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
  });
  moveTabIndicator();
}

function moveTabIndicator(){
  const ind = $('#tabIndicator');
  const active = $('#tabBtn-' + state.tab);
  if (!ind || !active) return;
  const parentRect = active.parentElement.getBoundingClientRect();
  const r = active.getBoundingClientRect();
  ind.style.width = r.width + 'px';
  ind.style.transform = `translateX(${r.left - parentRect.left}px)`;
}

function shakeEventTab(){
  const btn = $('#tabBtn-event');
  if (!btn) return;
  btn.classList.remove('shake');
  void btn.offsetWidth;
  btn.classList.add('shake');
  setTimeout(() => btn.classList.remove('shake'), 560);
  const lock = btn.querySelector('.lock-float');
  if (lock){
    lock.classList.remove('play');
    void lock.offsetWidth;
    lock.classList.add('play');
  }
}

function initTabs(){
  $$('.tabnav .tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tab = btn.dataset.tab;
      if (btn.classList.contains('locked') && !isEventUnlocked()){
        shakeEventTab();
        toast('Belum ada event yang dibuka pengurus MPK');
        return;
      }
      setTab(tab);
    });
  });
  // Keyboard arrow
  $('#tabnav').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const order = TABS;
    const idx = order.indexOf(state.tab);
    const next = e.key === 'ArrowRight' ? (idx + 1) % order.length : (idx - 1 + order.length) % order.length;
    const btn = $('#tabBtn-' + order[next]);
    if (order[next] === 'event' && !isEventUnlocked()) return;
    btn.focus();
    setTab(order[next]);
  });

  // Hash routing
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#','') || 'beranda';
    applyHash(h);
  });
  applyHash(location.hash.replace('#','') || 'beranda', true);
}

function applyHash(h, initial = false){
  if (!TABS.includes(h)) h = 'beranda';
  if (h === 'event' && !isEventUnlocked()){
    if (!initial) toast('Belum ada event yang dibuka pengurus MPK');
    if (location.hash !== '#beranda') history.replaceState(null, '', '#beranda');
    h = 'beranda';
  }
  if (h !== state.tab){
    state.tab = h;
    // langsung tampilkan (initial)
    TABS.forEach(t => {
      const p = $('#panel-' + t);
      const on = t === h;
      p.hidden = !on;
      if (on) p.classList.add('entering');
    });
    setTimeout(() => {
      TABS.forEach(t => $('#panel-' + t).classList.remove('entering'));
    }, 500);
    setAuroraTab(h);
    syncTabs();
  }
}

/* ============================================================
   RENDER: DAFTAR UMUM
   ============================================================ */
function renderListUmumSkeleton(){
  const el = $('#listUmum');
  el.innerHTML = '';
  for (let i = 0; i < 4; i++){
    const d = document.createElement('div');
    d.className = 'sk';
    el.appendChild(d);
  }
  $('#listHitung').textContent = 'Memuat…';
  $('#btnMuat').hidden = true;
}

function renderListUmum(){
  const el = $('#listUmum');
  el.innerHTML = '';
  const items = state.listUmum.items;
  if (!state.listUmum.inited && !items.length){
    renderListUmumSkeleton();
    return;
  }
  if (!items.length){
    const k = document.createElement('div');
    k.className = 'kosong';
    k.textContent = state.filter === 'all'
      ? 'Belum ada aspirasi. Jadilah yang pertama mengirim!'
      : 'Belum ada aspirasi dengan status ' + state.filter + '.';
    el.appendChild(k);
    $('#listHitung').textContent = '0 aspirasi';
    $('#btnMuat').hidden = true;
    return;
  }
  const frag = document.createDocumentFragment();
  items.forEach((a, i) => frag.appendChild(buildCard(a, i < 3)));
  el.appendChild(frag);
  $('#listHitung').textContent = items.length + ' aspirasi';
  $('#btnMuat').hidden = !state.listUmum.hasMore;
}

function buildCard(a, reveal){
  const card = document.createElement('article');
  card.className = 'card' + (reveal ? ' reveal' : '');
  card.dataset.id = a.id;

  const top = document.createElement('div');
  top.className = 'card-top';
  const pill = document.createElement('span');
  pill.className = pillClass(a.status);
  pill.textContent = a.status;
  top.appendChild(pill);
  const date = document.createElement('span');
  date.className = 'card-date';
  try { date.textContent = dfID.format(new Date(a.created_at)); } catch(_){ date.textContent = ''; }
  top.appendChild(date);

  const isi = document.createElement('p');
  isi.className = 'card-isi';
  isi.textContent = a.isi;

  const foot = document.createElement('div');
  foot.className = 'card-foot';

  const vbtn = document.createElement('button');
  vbtn.className = 'vote-btn' + (state.voted.includes(a.id) ? ' voted' : '');
  vbtn.type = 'button';
  vbtn.setAttribute('aria-label', 'Dukung aspirasi ini');
  const arrow = document.createElement('span'); arrow.textContent = '▲';
  const num = document.createElement('span');
  num.className = 'vote-num';
  num.textContent = String(a.votes | 0);
  vbtn.appendChild(arrow); vbtn.appendChild(num);
  vbtn.addEventListener('click', () => onVote(a, vbtn, num));
  if (a.status === 'Ditolak'){
    vbtn.disabled = true;
    vbtn.title = 'Aspirasi yang ditolak tidak bisa didukung';
  }
  foot.appendChild(vbtn);

  // Admin controls
  if (state.admin.active){
    const sel = document.createElement('select');
    sel.className = 'status-select';
    ['Hold','Diproses','Selesai','Ditolak'].forEach(s => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s;
      if (s === a.status) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => onStatusChange(a, sel));
    foot.appendChild(sel);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'tombol netral kecil';
    del.innerHTML = '<span class="glow"></span>Hapus';
    del.addEventListener('click', () => onDeleteAspirasi(a, card));
    foot.appendChild(del);

    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.className = 'tombol netral kecil';
    hideBtn.innerHTML = '<span class="glow"></span>' + (a.hidden ? 'Tampilkan' : 'Sembunyikan');
    hideBtn.addEventListener('click', () => onToggleHidden(a, card));
    foot.appendChild(hideBtn);

    // Lencana "Disembunyikan" (hanya admin yang lihat)
    if (a.hidden) {
      const badge = document.createElement('span');
      badge.className = 'pill';
      badge.style.background = 'rgba(120,130,140,.24)';
      badge.style.borderColor = 'rgba(120,130,140,.4)';
      badge.style.color = '#4E5A60';
      badge.textContent = 'Disembunyikan';
      top.appendChild(badge);
      card.classList.add('is-hidden');
    }
  }

  card.appendChild(top);
  card.appendChild(isi);
  card.appendChild(foot);
  return card;
}

function pillClass(status){
  return 'pill pill-' + String(status || 'Hold').toLowerCase();
}

async function onVote(a, btn, numEl){
  if (btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  const before = a.votes | 0;
  const already = state.voted.includes(a.id);

  // optimistic
  if (!already){
    a.votes = before + 1;
    numEl.textContent = String(a.votes);
    numEl.classList.remove('bump'); void numEl.offsetWidth; numEl.classList.add('bump');
    btn.classList.add('voted');
  }

  const r = await api('/rest/v1/rpc/vote_aspirasi', {
    method: 'POST',
    body: { p_client_id: state.clientId, p_id: a.id }
  });

  if (!r.ok){
    toast(r.error || 'Gagal mengirim dukungan', { err: true });
    // rollback
    if (!already){
      a.votes = before;
      numEl.textContent = String(before);
      btn.classList.remove('voted');
    }
  } else if (r.data && r.data.success){
    a.votes = r.data.votes | 0;
    numEl.textContent = String(a.votes);
    if (r.data.already){
      markVoted(a.id);
      state.voted = getVotedIds();
      btn.classList.add('voted');
    } else {
      markVoted(a.id);
      state.voted = getVotedIds();
      btn.classList.add('voted');
    }
  }
  btn.dataset.busy = '0';
}

async function onStatusChange(a, sel){
  const prev = a.status;
  const next = sel.value;
  a.status = next; // optimistic
  const r = await api('/rest/v1/rpc/admin_set_status', {
    method: 'POST',
    body: { p_id: a.id, p_status: next }
  });
  if (!r.ok){
    toast(r.error || 'Gagal mengubah status', { err: true });
    a.status = prev;
    sel.value = prev;
    return;
  }
  // update pill warna
  const card = sel.closest('.card');
  const pill = card && card.querySelector('.pill');
  if (pill){ pill.className = pillClass(next); pill.textContent = next; }
  const vb = card && card.querySelector('.vote-btn');
  if (vb){ vb.disabled = next === 'Ditolak'; vb.title = vb.disabled ? 'Aspirasi yang ditolak tidak bisa didukung' : ''; }
  toast('Status diperbarui');
}

async function onToggleHidden(a, card){
  const next = !a.hidden;
  const r = await api('/rest/v1/rpc/admin_set_hidden', {
    method: 'POST',
    body: { p_id: a.id, p_hidden: next }
  });
  if (!r.ok){
    toast(r.error || 'Gagal mengubah visibilitas', { err: true });
    return;
  }
  a.hidden = next;
  // Update tombol label
  const btns = card.querySelectorAll('button.tombol.netral.kecil');
  const hideBtn = btns[btns.length - 1]; // tombol terakhir adalah hide/show
  if (hideBtn){
    hideBtn.replaceChildren();
    const glow = document.createElement('span');
    glow.className = 'glow';
    hideBtn.appendChild(glow);
    hideBtn.appendChild(document.createTextNode(next ? 'Tampilkan' : 'Sembunyikan'));
  }
  // Update lencana & class
  const top = card.querySelector('.card-top');
  if (next){
    const badge = document.createElement('span');
    badge.className = 'pill';
    badge.style.background = 'rgba(120,130,140,.24)';
    badge.style.borderColor = 'rgba(120,130,140,.4)';
    badge.style.color = '#4E5A60';
    badge.textContent = 'Disembunyikan';
    top.appendChild(badge);
    card.classList.add('is-hidden');
  } else {
    const badges = top.querySelectorAll('.pill');
    badges.forEach(b => { if (b.textContent === 'Disembunyikan') b.remove(); });
    card.classList.remove('is-hidden');
  }
  toast(next ? 'Aspirasi disembunyikan' : 'Aspirasi ditampilkan');
}

/* ============================================================
   SUBTAB ASPIRASI
   ============================================================ */
function initSubTab(){
  const seg = $('#segAspirasi');
  const ind = $('#segIndicator');
  function update(){
    const on = seg.querySelector('button[aria-selected="true"]');
    if (!on || !ind) return;
    const parentRect = seg.getBoundingClientRect();
    const r = on.getBoundingClientRect();
    ind.style.width = r.width + 'px';
    ind.style.transform = `translateX(${r.left - parentRect.left}px)`;
  }
  seg.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(x => {
        const on = x === b;
        x.setAttribute('aria-selected', on ? 'true' : 'false');
        x.tabIndex = on ? 0 : -1;
      });
      state.subTab = b.dataset.seg;
      $('#subIsi').hidden = state.subTab !== 'isi';
      $('#subDaftar').hidden = state.subTab !== 'daftar';
      update();
      if (state.subTab === 'daftar') ensureListUmum();
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'){
        e.preventDefault();
        const list = Array.from(seg.querySelectorAll('button'));
        const idx = list.indexOf(b);
        const next = e.key === 'ArrowRight' ? (idx + 1) % list.length : (idx - 1 + list.length) % list.length;
        list[next].click();
        list[next].focus();
      }
    });
  });
  // ukur setelah render
  requestAnimationFrame(update);
  window.addEventListener('resize', update);
  setTimeout(update, 60);
}

/* ============================================================
   FORM KIRIM
   ============================================================ */
function initForm(){
  const ta = $('#taIsi');
  const cnt = $('#penghitung');
  const btn = $('#btnKirim');

  function updateCount(){
    const len = ta.value.length;
    const sisa = 1000 - len;
    cnt.textContent = sisa + ' karakter tersisa';
    cnt.classList.toggle('hampir', sisa <= 80);
  }
  ta.addEventListener('input', updateCount);
  updateCount();

  btn.addEventListener('click', () => submitAspirasi(ta, cnt, btn, null));
}

async function submitAspirasi(ta, cnt, btn, eventId){
  const isi = ta.value.trim();
  if (!isi){ toast('Tulis aspirasimu dulu ya', { err: true }); ta.focus(); return; }
  if (isi.length > 1000){ toast('Aspirasi maksimal 1000 karakter', { err: true }); return; }

  // Simpan label asli sekali saja, lalu ganti seluruh isi tombol (ikon kilau + satu teks).
  if (!btn.dataset.label) btn.dataset.label = btn.textContent.trim();
  const glow = btn.querySelector('.glow');
  const setLabel = (txt) => {
    btn.replaceChildren();
    if (glow) btn.appendChild(glow);
    btn.appendChild(document.createTextNode(txt));
  };
  btn.disabled = true;
  setLabel('Mengirim…');

  const r = await api('/rest/v1/rpc/submit_aspirasi', {
    method: 'POST',
    body: { p_client_id: state.clientId, p_isi: isi, p_event_id: eventId || null }
  });

  btn.disabled = false;
  setLabel(btn.dataset.label);

  if (!r.ok){ toast(r.error || 'Gagal mengirim aspirasi', { err: true }); return; }

  ta.value = '';
  if (cnt) cnt.textContent = '1000 karakter tersisa';
  toast('Aspirasi terkirim. Terima kasih sudah bersuara!');
  confettiBurst();

  if (eventId){
    // muat ulang daftar event ini
    const b = state.listEvent[eventId];
    if (b){ b.offset = 0; b.items = []; await loadListEventPage(eventId, 0, false); }
  } else {
    // pindah ke daftar + segarkan
    const segBtn = $('#segAspirasi button[data-seg="daftar"]');
    if (segBtn) segBtn.click();
    await refreshListUmum();
    loadStats();
  }
}

async function refreshListUmum(){
  await loadListUmumPage(0, false);
  loadStats();
}

function ensureListUmum(){
  if (!state.listUmum.inited){
    const cached = cacheGet(K.listU);
    if (cached){
      state.listUmum.items = cached;
      state.listUmum.inited = true;
      state.listUmum.hasMore = false;
      renderListUmum();
    }
  }
  // revalidate
  loadListUmumPage(0, false);
}

function initListControls(){
  $('#btnSegarkan').addEventListener('click', () => { refreshListUmum(); toast('Menyegarkan…', { ttl: 1400 }); });
  $('#btnMuat').addEventListener('click', () => {
    loadListUmumPage(state.listUmum.offset, true);
  });
  $('#btnRetry').addEventListener('click', () => {
    setOffline(false);
    refreshListUmum();
    loadEvents();
    loadStats();
  });
}

function setOffline(on){
  state.offline = on;
  const bar = $('#offlineBar');
  if (!bar) return;
  bar.classList.toggle('tampil', on);
}

/* ============================================================
   EVENT
   ============================================================ */
function ensureEvents(){
  if (state.eventsLoaded && state.events.length) return;
  loadEvents();
}

function renderEventList(){
  const wrap = $('#eventList');
  const empty = $('#eventEmpty');
  wrap.innerHTML = '';

  if (!state.events.length){
    empty.hidden = false;
    empty.textContent = state.admin.active
      ? 'Belum ada event. Klik "+ Tambah event baru" di atas.'
      : 'Belum ada event yang dibuka pengurus MPK.';
    return;
  }
  empty.hidden = true;

  state.events.forEach(ev => {
    const card = document.createElement('article');
    card.className = 'event-card glass';
    card.dataset.id = ev.id;
    card.classList.toggle('is-locked', !!ev.locked);

    const head = document.createElement('div');
    head.className = 'event-head';

    const nama = document.createElement('h3');
    nama.className = 'event-nama';
    nama.textContent = ev.nama;
    head.appendChild(nama);

    const right = document.createElement('div');
    right.style.display = 'flex'; right.style.gap = '8px'; right.style.flexWrap = 'wrap';

    const badge = document.createElement('span');
    badge.className = 'pill ' + (ev.locked ? 'pill-locked' : 'pill-open');
    badge.textContent = ev.locked ? '🔒 Terkunci' : 'Terbuka';
    right.appendChild(badge);

    const toggle = document.createElement('button');
    toggle.className = 'event-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<span>' + (ev.locked ? 'Lihat arsip' : 'Lihat') + '</span>';
    toggle.addEventListener('click', () => toggleEvent(card, ev));
    right.appendChild(toggle);

    head.appendChild(right);
    card.appendChild(head);

    const stat = document.createElement('p');
    stat.className = 'event-status';
    stat.textContent = ev.locked
      ? 'Sedang ditutup pengurus MPK. Aspirasi baru belum diterima, arsip lama tetap bisa dilihat.'
      : 'Terbuka. Kamu bisa mengirim aspirasi untuk event ini.';
    card.appendChild(stat);

    // admin inline rename
    if (state.admin.active){
      const rn = document.createElement('div');
      rn.className = 'inline-rename';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.value = ev.nama; inp.maxLength = 100;
      inp.setAttribute('aria-label', 'Ganti nama event');
      const btnSave = document.createElement('button');
      btnSave.className = 'tombol netral kecil';
      btnSave.innerHTML = '<span class="glow"></span>Simpan nama';
      btnSave.addEventListener('click', () => saveEventName(ev, inp.value));
      const btnLock = document.createElement('button');
      btnLock.className = 'tombol netral kecil';
      btnLock.innerHTML = '<span class="glow"></span>' + (ev.locked ? 'Buka' : 'Kunci');
      btnLock.addEventListener('click', () => toggleEventLock(ev));
      rn.appendChild(inp); rn.appendChild(btnSave); rn.appendChild(btnLock);
      if (ev.locked){
        const btnDel = document.createElement('button');
        btnDel.className = 'tombol netral kecil';
        btnDel.innerHTML = '<span class="glow"></span>Hapus event';
        btnDel.addEventListener('click', () => onDeleteEvent(ev));
        rn.appendChild(btnDel);
      }
      card.appendChild(rn);
    }

    // body (hidden, diload saat dibuka)
    const body = document.createElement('div');
    body.className = 'event-body';
    body.inert = true;
    const inner = document.createElement('div');
    inner.className = 'eb-in';
    body.appendChild(inner);
    card.appendChild(body);

    wrap.appendChild(card);

    // pulihkan kondisi terbuka setelah daftar dirender ulang
    const bk = state.listEvent[ev.id];
    if (bk && bk.open){
      body.classList.add('open'); body.inert = false;
      toggle.setAttribute('aria-expanded', 'true');
      toggle.querySelector('span').textContent = 'Tutup';
      renderEventBody(ev.id);
    }
  });
}

async function toggleEvent(card, ev){
  const body = card.querySelector('.event-body');
  const toggle = card.querySelector('.event-toggle');
  const bucket = state.listEvent[ev.id] || (state.listEvent[ev.id] = {
    items: [], offset: 0, hasMore: false, loading: false, loaded: false, open: false
  });
  const lbl = ev.locked ? 'Lihat arsip' : 'Lihat';

  if (!bucket.open){
    bucket.open = true;
    renderEventBody(ev.id);
    body.inert = false;
    body.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.querySelector('span').textContent = 'Tutup';
    if (!bucket.loaded) loadListEventPage(ev.id, 0, false);
  } else {
    bucket.open = false;
    body.classList.remove('open');
    body.inert = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.querySelector('span').textContent = lbl;
  }
}

function renderEventBody(eventId){
  const card = document.querySelector('.event-card[data-id="' + eventId + '"]');
  if (!card) return;
  const body = card.querySelector('.event-body');
  const inner = body.querySelector('.eb-in');
  const ev = state.events.find(e => e.id === eventId);
  const b = state.listEvent[eventId] || { items: [], hasMore: false, loading: false };
  inner.innerHTML = '';

  if (!ev.locked){
    // form
    const form = document.createElement('div');
    form.className = 'event-form form-kaca kaca-ringan';
    const ta = document.createElement('textarea');
    ta.maxLength = 1000;
    ta.placeholder = 'Tulis aspirasi untuk event ini…';
    ta.setAttribute('aria-label', 'Tulis aspirasi untuk event ini');
    const foot = document.createElement('div');
    foot.className = 'form-baris';
    foot.style.marginTop = '10px';
    const cnt = document.createElement('span');
    cnt.className = 'penghitung';
    cnt.textContent = '1000 karakter tersisa';
    const kirim = document.createElement('button');
    kirim.className = 'tombol';
    kirim.innerHTML = '<span class="glow"></span>Kirim aspirasi';
    foot.appendChild(cnt); foot.appendChild(kirim);
    form.appendChild(ta); form.appendChild(foot);
    inner.appendChild(form);

    ta.addEventListener('input', () => {
      const sisa = 1000 - ta.value.length;
      cnt.textContent = sisa + ' karakter tersisa';
      cnt.classList.toggle('hampir', sisa <= 80);
    });
    kirim.addEventListener('click', async () => {
      const isi = ta.value.trim();
      if (!isi){ toast('Tulis aspirasimu dulu ya', { err: true }); ta.focus(); return; }
      kirim.disabled = true;
      const r = await api('/rest/v1/rpc/submit_aspirasi', {
        method: 'POST',
        body: { p_client_id: state.clientId, p_isi: isi, p_event_id: eventId }
      });
      kirim.disabled = false;
      if (!r.ok){ toast(r.error || 'Gagal mengirim aspirasi', { err: true }); return; }
      ta.value = '';
      cnt.textContent = '1000 karakter tersisa';
      toast('Aspirasi event terkirim!');
      confettiBurst();
      b.offset = 0;
      await loadListEventPage(eventId, 0, false);
    });
  }

  // daftar aspirasi event
  const list = document.createElement('div');
  list.className = 'list';
  list.style.marginTop = '16px';
  if (!b.items.length && b.loading){
    for (let i = 0; i < 2; i++){
      const sk = document.createElement('div'); sk.className = 'sk'; list.appendChild(sk);
    }
  } else if (!b.items.length){
    const k = document.createElement('div');
    k.className = 'kosong';
    k.textContent = b.error
      ? 'Aspirasi belum bisa dimuat. Tutup lalu buka lagi event ini.'
      : (ev.locked ? 'Belum ada aspirasi di event ini.' : 'Belum ada aspirasi di sini. Jadilah yang pertama!');
    list.appendChild(k);
  } else {
    b.items.forEach((a, i) => list.appendChild(buildCard(a, i < 3)));
  }
  inner.appendChild(list);

  if (b.hasMore){
    const wrapMore = document.createElement('div');
    wrapMore.style.textAlign = 'center';
    wrapMore.style.marginTop = '14px';
    const btn = document.createElement('button');
    btn.className = 'tombol netral kecil';
    btn.innerHTML = '<span class="glow"></span>Muat lebih banyak';
    btn.addEventListener('click', () => loadListEventPage(eventId, b.offset, true));
    wrapMore.appendChild(btn);
    inner.appendChild(wrapMore);
  }
}

async function saveEventName(ev, val){
  const r = await api('/rest/v1/rpc/admin_rename_event', {
    method: 'POST',
    body: { p_id: ev.id, p_nama: val }
  });
  if (!r.ok){ toast(r.error || 'Gagal mengganti nama', { err: true }); return; }
  await loadEvents(); // ambil nama terbaru dari server (RPC hanya mengembalikan success)
  toast('Nama event diperbarui');
}

async function toggleEventLock(ev){
  const r = await api('/rest/v1/rpc/admin_set_event_lock', {
    method: 'POST',
    body: { p_id: ev.id, p_locked: !ev.locked }
  });
  if (!r.ok){ toast(r.error || 'Gagal mengubah kunci event', { err: true }); return; }
  ev.locked = !ev.locked; // RPC hanya mengembalikan success, jadi balik nilai lokal
  cacheSet(K.events, state.events);
  updateEventGate();
  renderEventList();
  // reload body bila terbuka
  const b = state.listEvent[ev.id];
  if (b && b.open) renderEventBody(ev.id);
  toast(ev.locked ? 'Event dikunci' : 'Event dibuka');
}

async function onDeleteEvent(ev){
  if (!ev.locked){ toast('Kunci event dulu sebelum menghapus', { err: true }); return; }
  const ok = await askConfirm('Event "' + ev.nama + '" akan dihapus permanen BESERTA semua aspirasi dan dukungan di dalamnya. Tidak bisa dikembalikan. Lanjutkan?', 'Hapus event');
  if (!ok) return;
  const r = await api('/rest/v1/rpc/admin_delete_event', { method: 'POST', body: { p_id: ev.id } });
  if (!r.ok){ toast(r.error || 'Gagal menghapus event', { err: true }); return; }
  state.events = state.events.filter(e => e.id !== ev.id);
  delete state.listEvent[ev.id];
  cacheSet(K.events, state.events);
  updateEventGate();
  renderEventList();
  loadStats();
  toast('Event dihapus');
}

async function onCreateEvent(){
  const r = await api('/rest/v1/rpc/admin_create_event', { method: 'POST', body: {} });
  if (!r.ok){ toast(r.error || 'Gagal membuat event', { err: true }); return; }
  await loadEvents();
  toast('Event baru dibuat');
}

/* ============================================================
   KONFIRMASI, HAPUS, FILTER
   ============================================================ */
function askConfirm(text, yesLabel){
  return new Promise(resolve => {
    const m = $('#confirmModal');
    $('#confirmText').textContent = text;
    const yes = $('#btnConfirmYes'), no = $('#btnConfirmNo');
    yes.lastChild.textContent = yesLabel || 'Hapus';
    const done = (v) => {
      yes.removeEventListener('click', onYes); no.removeEventListener('click', onNo);
      m.removeEventListener('click', onBack);
      closeModal(m); resolve(v);
    };
    const onYes = () => done(true), onNo = () => done(false);
    const onBack = (e) => { if (e.target === m) done(false); };
    yes.addEventListener('click', onYes); no.addEventListener('click', onNo);
    m.addEventListener('click', onBack);
    openModal(m); no.focus();
  });
}

async function onDeleteAspirasi(a, card){
  const ok = await askConfirm('Aspirasi ini akan dihapus permanen beserta dukungannya dan tidak bisa dikembalikan. Lanjutkan?', 'Hapus');
  if (!ok) return;
  const r = await api('/rest/v1/rpc/admin_delete_aspirasi', { method: 'POST', body: { p_id: a.id } });
  if (!r.ok){ toast(r.error || 'Gagal menghapus aspirasi', { err: true }); return; }
  state.listUmum.items = state.listUmum.items.filter(x => x.id !== a.id);
  if (a.event_id && state.listEvent[a.event_id]){
    const b = state.listEvent[a.event_id];
    b.items = b.items.filter(x => x.id !== a.id);
  }
  if (card){
    card.classList.add('hapus-out');
    setTimeout(() => {
      if (a.event_id) renderEventBody(a.event_id); else renderListUmum();
    }, 300);
  }
  loadStats();
  toast('Aspirasi dihapus');
}

function initFilterChips(){
  const wrap = $('#filterChips');
  if (!wrap) return;
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b || b.dataset.s === state.filter) return;
    state.filter = b.dataset.s;
    wrap.querySelectorAll('.chip').forEach(x => {
      const on = x === b;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    state.listUmum.items = []; state.listUmum.offset = 0; state.listUmum.hasMore = false; state.listUmum.inited = false;
    renderListUmumSkeleton();
    loadListUmumPage(0, false);
  });
}

/* ============================================================
   ADMIN
   ============================================================ */
// Satu promise refresh bersama: refresh token sekali pakai, jadi request paralel menunggu hasil yang sama.
let refreshPromise = null;
function tryRefreshAdmin(){
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefreshAdmin().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function doRefreshAdmin(){
  if (!state.admin.refresh) return false;
  const r = await rawFetch('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: state.admin.refresh })
  }).then(async res => {
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return { ok: true, data };
  }).catch(() => ({ ok: false }));

  if (!r.ok || !r.data) return false;
  state.admin.token = r.data.access_token;
  state.admin.refresh = r.data.refresh_token || state.admin.refresh;
  state.admin.expiresAt = Date.now() + ((r.data.expires_in || 3600) - 60) * 1000;
  scheduleAdminRefresh();
  return true;
}

function scheduleAdminRefresh(){
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  const ms = Math.max(30000, state.admin.expiresAt - Date.now() - 60000);
  state.refreshTimer = setTimeout(() => tryRefreshAdmin(), ms);
}

async function doAdminLogin(password){
  const r = await rawFetch('/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password })
  }).then(async res => {
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  }).catch(() => ({ ok: false, net: true }));

  if (!r.ok || !r.data || !r.data.access_token){
    return { ok: false, error: r.net ? 'Tidak bisa terhubung ke server. Periksa koneksi lalu coba lagi.' : 'Kode akses salah' };
  }
  state.admin.token = r.data.access_token;
  state.admin.refresh = r.data.refresh_token || null;
  state.admin.expiresAt = Date.now() + ((r.data.expires_in || 3600) - 60) * 1000;
  state.admin.active = true;

  // cek is_admin
  const chk = await api('/rest/v1/rpc/is_admin', { method: 'POST', body: {} });
  if (!chk.ok || chk.data !== true){
    forceAdminLogout('Kode akses salah');
    return { ok: false, error: 'Kode akses salah' };
  }
  scheduleAdminRefresh();
  return { ok: true };
}

function forceAdminLogout(msg){
  state.admin.active = false;
  state.admin.token = null;
  state.admin.refresh = null;
  state.admin.expiresAt = 0;
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = null;
  updateAdminUI();
  if (msg) toast(msg);
}

function updateAdminUI(){
  const sb = $('#settingsBtn');
  sb.classList.toggle('admin', state.admin.active);
  const label = $('#adminLabel');
  const desc = $('#adminDesc');
  const btn = $('#btnAdminToggle');
  if (state.admin.active){
    label.textContent = 'Admin aktif';
    desc.textContent = 'Kamu bisa mengelola aspirasi & event';
    btn.textContent = 'Keluar';
    btn.classList.remove('biru');
    btn.classList.add('netral');
  } else {
    label.textContent = 'Masuk sebagai Admin';
    desc.textContent = 'Kelola aspirasi & event';
    btn.textContent = 'Masuk';
    btn.classList.remove('netral');
    btn.classList.add('biru');
  }
  // muat ulang daftar supaya status Ditolak muncul / hilang
  if (state.listUmum.inited) loadListUmumPage(0, false);
  if (state.tab === 'event') renderEventList();
  $('#btnAddEvent').hidden = !state.admin.active;
}

/* ============================================================
   SETTINGS & MODAL
   ============================================================ */
function openModal(el){ el.hidden = false; document.body.style.overflow = 'hidden'; }
function closeModal(el){ el.hidden = true; document.body.style.overflow = ''; }

function initSettings(){
  const btnS = $('#settingsBtn');
  const modalS = $('#settingsModal');
  const modalL = $('#loginModal');

  btnS.addEventListener('click', () => {
    updateAdminUI();
    openModal(modalS);
  });
  $('#btnSettingsClose').addEventListener('click', () => closeModal(modalS));
  modalS.addEventListener('click', (e) => { if (e.target === modalS) closeModal(modalS); });

  // admin toggle
  $('#btnAdminToggle').addEventListener('click', () => {
    if (state.admin.active){
      forceAdminLogout('Keluar dari mode admin');
      updateAdminUI();
      return;
    }
    closeModal(modalS);
    $('#inpKode').value = '';
    openModal(modalL);
    setTimeout(() => $('#inpKode').focus(), 120);
  });

  // login modal
  $('#btnLoginBatal').addEventListener('click', () => { closeModal(modalL); openModal(modalS); });
  modalL.addEventListener('click', (e) => { if (e.target === modalL) { closeModal(modalL); openModal(modalS); } });
  $('#btnLoginMasuk').addEventListener('click', doLoginAttempt);
  $('#inpKode').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLoginAttempt(); });

  async function doLoginAttempt(){
    const pw = $('#inpKode').value;
    if (!pw){ toast('Masukkan kode akses dulu', { err: true }); return; }
    const btn = $('#btnLoginMasuk');
    btn.disabled = true;
    const r = await doAdminLogin(pw);
    btn.disabled = false;
    if (!r.ok){ toast(r.error || 'Kode akses salah', { err: true }); return; }
    closeModal(modalL);
    toast('Admin aktif. Selamat bekerja!');
    updateAdminUI();
  }

  // lite toggle
  const tglLite = $('#tglLite');
  const liteDesc = $('#liteDesc');
  const manual = safeGet('mpk_v3_lite_manual');
  if (manual === '1'){ state.liteManual = true; }
  else if (manual === '0'){ state.liteManual = false; }
  applyLite();

  tglLite.addEventListener('click', () => {
    const next = !state.lite;
    state.liteManual = next;
    safeSet('mpk_v3_lite_manual', next ? '1' : '0');
    applyLite();
  });

  function applyLite(){
    const auto = detectLite();
    state.lite = state.liteManual === null ? auto : state.liteManual;
    document.body.classList.toggle('lite', state.lite);
    tglLite.classList.toggle('on', state.lite);
    tglLite.setAttribute('aria-checked', state.lite ? 'true' : 'false');
    liteDesc.textContent = state.liteManual === null ? 'Otomatis' : (state.lite ? 'Aktif' : 'Nonaktif');
    // rebuild doodles bila perlu
    if (doodleEls.length) buildDoodles();
  }

  // suara toggle
  const tglMute = $('#tglMute');
  const muteDesc = $('#muteDesc');
  function applyMute(){
    tglMute.classList.toggle('on', !state.muted);
    tglMute.setAttribute('aria-checked', state.muted ? 'false' : 'true');
    muteDesc.textContent = state.muted ? 'Nonaktif' : 'Aktif';
  }
  tglMute.addEventListener('click', () => {
    state.muted = !state.muted;
    safeSet('mpk_v3_muted', state.muted ? '1' : '0');
    applyMute();
  });
  applyMute();
}

function detectLite(){
  const hc = navigator.hardwareConcurrency || 8;
  const dm = navigator.deviceMemory || 8;
  const rm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (rm) return true;
  if (hc <= 4) return true;
  if (dm <= 4) return true;
  return false;
}

/* ============================================================
   CONFETTI
   ============================================================ */
const confCanvas = $('#confetti');
let confCtx = null, confParts = [], confRAF = null;

function confettiBurst(){
  if (state.lite && Math.random() < 0.4) return; // hemat di lite (kadang)
  const w = window.innerWidth, h = window.innerHeight;
  confCanvas.width = w; confCanvas.height = h;
  confCanvas.classList.add('on');
  confCtx = confCanvas.getContext('2d');

  const N = state.lite ? 40 : 90;
  confParts = [];
  for (let i = 0; i < N; i++){
    confParts.push({
      x: w * 0.5 + (Math.random() - 0.5) * w * 0.3,
      y: h * 0.55,
      vx: (Math.random() - 0.5) * 10,
      vy: -Math.random() * 12 - 4,
      g: 0.32,
      life: 0,
      ttl: 1100 + Math.random() * 500,
      size: 4 + Math.random() * 6,
      color: ['#2F9BF4','#FFD23F','#3FB871','#F08A72','#1E7FD1'][Math.floor(Math.random() * 5)],
      rot: Math.random() * Math.PI * 2,
      rotV: (Math.random() - 0.5) * 0.3
    });
  }
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(40, now - last); last = now;
    confCtx.clearRect(0, 0, w, h);
    let alive = 0;
    for (const p of confParts){
      p.life += dt;
      if (p.life > p.ttl) continue;
      alive++;
      p.vy += p.g * (dt / 16);
      p.x += p.vx * (dt / 16);
      p.y += p.vy * (dt / 16);
      p.rot += p.rotV * (dt / 16);
      const alpha = 1 - p.life / p.ttl;
      confCtx.save();
      confCtx.globalAlpha = alpha;
      confCtx.translate(p.x, p.y);
      confCtx.rotate(p.rot);
      confCtx.fillStyle = p.color;
      confCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      confCtx.restore();
    }
    if (alive > 0){
      confRAF = requestAnimationFrame(step);
    } else {
      confCtx.clearRect(0, 0, w, h);
      confCanvas.classList.remove('on');
      confRAF = null;
    }
  };
  if (confRAF) cancelAnimationFrame(confRAF);
  confRAF = requestAnimationFrame(step);
}

/* ============================================================
   GLASS SHINE & BUTTON GLOW
   ============================================================ */
function initGlassShine(){
  const glassEls = () => $$('.glass, .tabnav, .settings-btn, .modal');
  let activeGlass = null;
  let clearTimer = null;
  let safetyTimer = null;

  function litOne(el){
    if (activeGlass && activeGlass !== el) activeGlass.classList.remove('lit');
    activeGlass = el;
    el.classList.add('lit');
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      if (activeGlass) activeGlass.classList.remove('lit');
      activeGlass = null;
    }, 1200);
  }
  function releaseAll(){
    if (activeGlass){ activeGlass.classList.remove('lit'); activeGlass = null; }
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
  }

  let rafSet = false;
  let pendEl = null, pendX = 0, pendY = 0;

  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.glass, .tabnav, .settings-btn, .modal');
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--x', ((e.clientX - r.left) / r.width * 100) + '%');
    el.style.setProperty('--y', ((e.clientY - r.top) / r.height * 100) + '%');
    litOne(el);
  }, { passive: true });

  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest('.glass, .tabnav, .settings-btn, .modal');
    if (!el) return;
    // hanya update kalau mouse
    if (e.pointerType === 'mouse'){
      const r = el.getBoundingClientRect();
      pendEl = el; pendX = ((e.clientX - r.left) / r.width * 100); pendY = ((e.clientY - r.top) / r.height * 100);
      if (!rafSet){
        rafSet = true;
        requestAnimationFrame(() => {
          rafSet = false;
          if (pendEl){
            pendEl.style.setProperty('--x', pendX + '%');
            pendEl.style.setProperty('--y', pendY + '%');
          }
        });
      }
      litOne(el);
    }
  }, { passive: true });

  const end = () => releaseAll();
  document.addEventListener('pointerup', end, { passive: true });
  document.addEventListener('pointercancel', end, { passive: true });
  document.addEventListener('pointerleave', end, { passive: true });

  // safety timer
  safetyTimer = setInterval(() => {
    if (activeGlass && performance.now() - state.lastInput > 1200) releaseAll();
  }, 500);
}

function initButtonGlow(){
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.tombol, .vote-btn, .event-toggle, .toggle');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    btn.style.setProperty('--gx', ((e.clientX - r.left) / r.width * 100) + '%');
    btn.style.setProperty('--gy', ((e.clientY - r.top) / r.height * 100) + '%');
    btn.classList.add('glow-on');
  }, { passive: true });

  const off = (e) => {
    const btn = e.target.closest && e.target.closest('.tombol, .vote-btn, .event-toggle, .toggle');
    if (btn) btn.classList.remove('glow-on');
  };
  document.addEventListener('pointerup', off, { passive: true });
  document.addEventListener('pointercancel', off, { passive: true });
  document.addEventListener('pointerleave', off, { passive: true });
}

/* ============================================================
   PROGRESS BAR SCROLL
   ============================================================ */
function initScrollEffects(){
  let rafPending = false;
  const prog = $('#progress');
  window.addEventListener('scroll', () => {
    state.lastInput = performance.now();
    state.parallax.scroll = window.scrollY || 0;
    if (!rafPending){
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        const h = document.documentElement.scrollHeight - window.innerHeight;
        const p = h > 0 ? Math.min(1, (window.scrollY || 0) / h) : 0;
        prog.style.transform = 'scaleX(' + p + ')';
      });
    }
  }, { passive: true });

  window.addEventListener('pointermove', (e) => {
    state.lastInput = performance.now();
    if (e.pointerType === 'mouse'){
      const w = window.innerWidth, h = window.innerHeight;
      state.parallax.tilX = (e.clientX / w - 0.5) * 2;
      state.parallax.tilY = (e.clientY / h - 0.5) * 2;
    }
  }, { passive: true });

  window.addEventListener('keydown', () => { state.lastInput = performance.now(); }, { passive: true });
  window.addEventListener('touchstart', () => { state.lastInput = performance.now(); }, { passive: true });
}

/* ============================================================
   PREFETCH
   ============================================================ */
function prefetchAll(){
  // jalankan paralel, tanpa menunggu intro
  // allSettled: satu request gagal tidak boleh menggagalkan yang lain
  Promise.allSettled([loadStats(), loadEvents(), loadListUmumPage(0, false)]);
}

/* ============================================================
   INIT
   ============================================================ */
function init(){
  initFilterChips();
  // intro inert
  $('#tabnav').setAttribute('inert', '');
  $('#app').setAttribute('inert', '');
  $('#settingsBtn').setAttribute('inert', '');

  // deteksi lite awal (sebelum applyLite user setting)
  if (detectLite()) document.body.classList.add('lite');

  buildDoodles();
  initLanyard();
  initTabs();
  initSubTab();
  initForm();
  initListControls();
  initSettings();
  initGlassShine();
  initButtonGlow();
  initScrollEffects();
  armIntro();

  // window resize → update indicator
  window.addEventListener('resize', moveTabIndicator);

  // visibility: jeda loop
  document.addEventListener('visibilitychange', () => {
    if (document.hidden){
      if (rafId){ cancelAnimationFrame(rafId); rafId = null; }
    } else if (state.introDone && !rafId){
      lastFrame = 0;
      rafId = requestAnimationFrame(loop);
    }
  });

  // Muat data awal
  prefetchAll();

  // Kalau cache stats ada, langsung tampilkan
  const cachedStats = cacheGet(K.stats);
  if (cachedStats){ state.stats = cachedStats; renderStats(false); }

  // Bind admin event handler
  $('#btnAddEvent').addEventListener('click', onCreateEvent);

  // update event gate tiap kali events berubah
  window.addEventListener('mpk-events-updated', updateEventGate);

  // initial state
  updateEventGate();
  syncTabs();
  requestAnimationFrame(moveTabIndicator);
}

document.addEventListener('DOMContentLoaded', init);
})();
