/**
 * Progressive web app bootstrap. Owned by the 'pwa' feature area.
 * - Registers the service worker (production builds only) and detects new deployments.
 * - Offline quick-capture outbox in IndexedDB, synced idempotently (clientRequestId) when the connection returns.
 * Only capture drafts the person typed are stored on the device; no API responses are cached.
 */
import { useSyncExternalStore } from 'react';

export interface OutboxItem {
  clientRequestId: string; userId: string; text: string; projectId: string | null; addToMyDay: boolean;
  /** Product chosen at capture time (applies when no project decides it). */
  productId?: string | null;
  capturedAt: string; status: 'pending' | 'failed'; error?: string; attempts?: number;
}
export interface SyncedCapture { task: { id: string; title: string }; replayed: boolean; warnings: string[]; addedToMyDay: boolean; planFull: boolean }
interface PwaState { online: boolean; items: OutboxItem[]; syncing: boolean; updateReady: boolean }

let state: PwaState = { online: typeof navigator === 'undefined' ? true : navigator.onLine, items: [], syncing: false, updateReady: false };
const listeners = new Set<() => void>();
const syncedListeners = new Set<(r: SyncedCapture[]) => void>();
let currentUser: string | null = null;
let channel: BroadcastChannel | null = null;

function set(p: Partial<PwaState>) { state = { ...state, ...p }; listeners.forEach((l) => l()); }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function usePwa() { return useSyncExternalStore(subscribe, () => state); }
export function onSynced(fn: (r: SyncedCapture[]) => void) { syncedListeners.add(fn); return () => { syncedListeners.delete(fn); }; }

export function newClientRequestId() {
  try { return crypto.randomUUID(); } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
}

// ---------- IndexedDB outbox ----------
const DB_NAME = 'tt-offline'; const STORE = 'captures';
// Who the outbox belongs to, so the offline fallback page can queue captures for them. Removed on sign-out.
const USER_KEY = 'tt-outbox-user';
let dbp: Promise<IDBDatabase> | null = null;
function idb() {
  dbp ??= new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'clientRequestId' });
    r.onsuccess = () => res(r.result); r.onerror = () => { dbp = null; rej(r.error); };
  });
  return dbp;
}
async function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise<T>((res, rej) => {
    const t = db.transaction(STORE, mode); const r = fn(t.objectStore(STORE));
    t.oncomplete = () => res(r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const allItems = () => store<OutboxItem[]>('readonly', (s) => s.getAll() as IDBRequest<OutboxItem[]>);
const putItem = (i: OutboxItem) => store('readwrite', (s) => s.put(i));
const delItem = (id: string) => store('readwrite', (s) => s.delete(id));

async function refresh() {
  try {
    const items = (await allItems()).filter((i) => i.userId === currentUser).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    set({ items });
  } catch { set({ items: [] }); }
}
function changed() { channel?.postMessage('changed'); return refresh(); }

/** Attach the outbox to the signed-in person. Drafts left by anyone else on this device are deleted, never sent under this session. */
export async function bindOutbox(userId: string, canCapture = true) {
  currentUser = userId;
  try { if (canCapture) localStorage.setItem(USER_KEY, userId); else localStorage.removeItem(USER_KEY); } catch { /* storage blocked */ }
  try { for (const i of await allItems()) if (i.userId !== userId) await delItem(i.clientRequestId); } catch { /* IndexedDB unavailable */ }
  await refresh();
  void syncOutbox();
}

export async function queueCapture(i: Omit<OutboxItem, 'status' | 'userId'>) {
  if (!currentUser) throw new Error('Not signed in');
  await putItem({ ...i, userId: currentUser, status: 'pending' });
  await changed();
  if (navigator.onLine) setTimeout(() => void syncOutbox(), 1500); // the failure may have been a blip
}

export async function retryCapture(id: string, text: string) {
  const i = state.items.find((x) => x.clientRequestId === id); if (!i) return;
  await putItem({ ...i, text, status: 'pending', error: undefined, attempts: 0 });
  await changed(); void syncOutbox();
}
export async function discardCapture(id: string) { await delItem(id); await changed(); }

let inFlight: Promise<void> | null = null;
export function syncOutbox(): Promise<void> {
  if (inFlight) return inFlight;
  if (!currentUser || !navigator.onLine || !state.items.some((i) => i.status === 'pending')) return Promise.resolve();
  const run = async () => {
    set({ syncing: true }); const done: SyncedCapture[] = [];
    try {
      for (const i of (await allItems()).filter((x) => x.userId === currentUser && x.status === 'pending').sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
        let res: Response;
        try {
          res = await fetch('/api/pwa/captures', { method: 'POST', credentials: 'same-origin', headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' },
            body: JSON.stringify({ clientRequestId: i.clientRequestId, userId: i.userId, text: i.text, capturedAt: i.capturedAt, projectId: i.projectId, productId: i.productId ?? null, addToMyDay: i.addToMyDay }) });
        } catch { break; } // still unreachable: keep everything for the next attempt
        if (res.ok) { done.push(await res.json()); await delItem(i.clientRequestId); continue; }
        if (res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 502) break; // sign in again / server unreachable or busy: retry later
        if (res.status >= 500) {
          // The server failed on this capture: retry it a few times, then let the person review it. It never blocks the captures behind it.
          const attempts = (i.attempts ?? 0) + 1;
          await putItem(attempts >= 3 ? { ...i, attempts, status: 'failed', error: 'The server could not create this capture. Edit it and retry, or discard it.' } : { ...i, attempts });
          continue;
        }
        const body = await res.json().catch(() => null);
        await putItem({ ...i, status: 'failed', error: body?.message ?? `Could not create the task (${res.status})` });
      }
    } finally {
      set({ syncing: false }); await changed();
      if (done.length) syncedListeners.forEach((l) => l(done));
    }
  };
  const locks = (navigator as any).locks;
  inFlight = (locks ? locks.request('tt-outbox-sync', { ifAvailable: true }, (lock: unknown) => (lock ? run() : undefined)) : run())
    .catch(() => undefined).finally(() => { inFlight = null; });
  return inFlight!;
}

/** Ask before signing out when drafts would be lost. */
export function confirmSignOut() {
  const n = state.items.length;
  return n === 0 || window.confirm(`${n} quick capture${n === 1 ? '' : 's'} on this device ${n === 1 ? 'has' : 'have'} not synced yet. Signing out deletes ${n === 1 ? 'it' : 'them'}. Sign out anyway?`);
}

/** On sign-out: delete the outbox and every Cache Storage entry, then let the service worker re-cache the public app shell. */
export async function clearOfflineData() {
  currentUser = null;
  try { localStorage.removeItem(USER_KEY); } catch { /* storage blocked */ }
  try { await store('readwrite', (s) => s.clear()); } catch { /* nothing stored */ }
  channel?.postMessage('changed');
  set({ items: [] });
  try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* Cache Storage unavailable */ }
  try { navigator.serviceWorker?.controller?.postMessage({ type: 'precache' }); } catch { /* no worker */ }
}

// ---------- Service worker + update detection ----------
const entryScript = (doc: Document) => doc.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? null;

async function checkForUpdate(current: string) {
  try {
    const html = await (await fetch('/', { cache: 'no-store', credentials: 'same-origin' })).text();
    const next = entryScript(new DOMParser().parseFromString(html, 'text/html'));
    if (next && next !== current) set({ updateReady: true });
  } catch { /* offline: check again later */ }
}

export function reloadForUpdate() { location.reload(); }
export function dismissUpdate() { set({ updateReady: false }); }

export function initPwa() {
  if (typeof window === 'undefined') return;
  addEventListener('online', () => { set({ online: true }); void syncOutbox(); });
  addEventListener('offline', () => set({ online: false }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void syncOutbox(); });
  setInterval(() => { if (state.items.some((i) => i.status === 'pending')) void syncOutbox(); }, 30_000);
  try { channel = new BroadcastChannel('tt-outbox'); channel.onmessage = () => void refresh(); } catch { /* single tab only */ }

  // Production builds only: the Vite dev server serves /src/main.tsx, not a hashed /assets/ entry.
  const entry = entryScript(document);
  if (!entry || !('serviceWorker' in navigator)) return;
  const version = entry.replace(/^.*\/([^/]+)\.js$/, '$1');
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'sw-activated' && hadController && e.data.version !== version) set({ updateReady: true });
  });
  const register = () => navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(version)}`, { scope: '/', updateViaCache: 'none' }).catch(() => { /* app works without it */ });
  if (document.readyState === 'complete') void register(); else addEventListener('load', () => void register());
  setInterval(() => void checkForUpdate(entry), 30 * 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !state.updateReady) void checkForUpdate(entry); });
}
