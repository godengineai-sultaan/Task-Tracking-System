import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

const api = (page: Page, method: string, url: string, body?: unknown) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch(u as string, { method: m as string, headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body] as const);
const axeSerious = async (page: Page) => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations
  .filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${v.id}: ${v.help} (${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} ${n.failureSummary ?? ''}`).join(' | ')})`);
/** A stand-in Web Speech API recogniser that "hears" one phrase (no microphone in CI). */
const fakeSpeech = () => {
  class FakeRecognition {
    onresult: any; onend: any; onerror: any; lang = ''; interimResults = false; continuous = false; maxAlternatives = 1;
    start() { setTimeout(() => { this.onresult?.({ results: [[{ transcript: 'Call the venue about seating tomorrow 15m' }]] }); this.onend?.(); }, 50); }
    stop() { this.onend?.(); }
    abort() { /* nothing recorded */ }
  }
  (window as any).webkitSpeechRecognition = FakeRecognition; (window as any).SpeechRecognition = FakeRecognition;
};
const outboxCount = (page: Page) => page.evaluate(() => new Promise<number>((res) => {
  const r = indexedDB.open('tt-offline', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('captures', { keyPath: 'clientRequestId' });
  r.onsuccess = () => { const c = r.result.transaction('captures').objectStore('captures').count(); c.onsuccess = () => res(c.result); };
}));
const captureOffline = async (page: Page, text: string) => {
  await page.keyboard.press('q');
  await page.getByLabel('Describe the task in one line').fill(text);
  await page.getByRole('button', { name: 'Save offline' }).click();
  await expect(page.getByLabel('Describe the task in one line')).toHaveCount(0);
};
const exactMatches = async (page: Page, title: string) => ((await api(page, 'GET', `/api/search?q=${encodeURIComponent(title)}`)).body.tasks as any[]).filter((t) => t.title === title).length;

test('installable: manifest, icons, offline page and service worker are served', async ({ page, request }) => {
  const m = await request.get('/manifest.webmanifest');
  expect(m.status()).toBe(200);
  const manifest = await m.json();
  expect(manifest).toMatchObject({ short_name: 'Tasks', display: 'standalone', start_url: '/' });
  for (const icon of manifest.icons) {
    const r = await request.get(icon.src);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()['content-type']).toContain('image/png');
  }
  const sw = await request.get('/sw.js');
  expect(sw.status()).toBe(200);
  expect(sw.headers()['content-type']).toContain('javascript');
  expect((await request.get('/offline.html')).status()).toBe(200);

  await signIn(page, 'dev');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  const scriptURL = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL ?? '');
  expect(scriptURL).toMatch(/\/sw\.js\?v=index-/);
  // Only the public app shell is cached: never an /api response.
  await expect.poll(() => page.evaluate(async () => {
    const urls: string[] = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname);
    return urls;
  })).toContain('/offline.html');
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname);
    return urls;
  });
  expect(cached.filter((u) => u.startsWith('/api/'))).toEqual([]);
  expect(cached.some((u) => u.startsWith('/assets/'))).toBe(true);
});

test('offline capture queues on the device and syncs exactly once after reconnect', async ({ page, context }) => {
  await signIn(page, 'dev');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const title = `Offline capture ${Date.now().toString(36)}`;
  await context.setOffline(true);
  await expect(page.getByText("You're offline.")).toBeVisible();
  await page.keyboard.press('q');
  await page.getByLabel('Describe the task in one line').fill(`${title} today 15m`);
  await expect(page.getByText(/This capture is kept on this device/)).toBeVisible();
  expect(await axeSerious(page)).toEqual([]); // the quick-capture dialog in its offline state
  await page.getByRole('button', { name: 'Save offline' }).click();
  await expect(page.getByText(/Saved on this device/)).toBeVisible();
  await expect(page.getByText('1 capture waiting to sync')).toBeVisible();
  // Still offline after a while: nothing is lost or sent.
  await page.waitForTimeout(500);
  await expect(page.getByText('1 capture waiting to sync')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync now' })).toHaveCount(0); // no dead control while offline
  expect(await axeSerious(page)).toEqual([]);

  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/pwa/captures')) posts.push(r.url()); });
  await context.setOffline(false);
  await expect(page.getByText('1 offline capture synced')).toBeVisible();
  await expect(page.getByText('waiting to sync')).toHaveCount(0);
  expect(await exactMatches(page, title)).toBe(1);

  // Reload and reconnect again: the outbox is empty, so nothing is re-sent.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(2000);
  expect(posts).toHaveLength(1);
  expect(await exactMatches(page, title)).toBe(1);
  const stored = await page.evaluate(() => new Promise<number>((res) => {
    const r = indexedDB.open('tt-offline', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('captures', { keyPath: 'clientRequestId' });
    r.onsuccess = () => { const c = r.result.transaction('captures').objectStore('captures').count(); c.onsuccess = () => res(c.result); };
  }));
  expect(stored).toBe(0);
});

test.describe('network failure while online', () => {
  test.use({ serviceWorkers: 'block' }); // so page.route sees every request
  test('a capture whose request fails is kept and synced once the server is reachable', async ({ page }) => {
    await signIn(page, 'meera');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const title = `Flaky network capture ${Date.now().toString(36)}`;
    await page.route('**/api/tasks', (r) => (r.request().method() === 'POST' ? r.abort('internetdisconnected') : r.continue()));
    await page.route('**/api/pwa/captures', (r) => r.abort('internetdisconnected'));
    await page.keyboard.press('q');
    await page.getByLabel('Describe the task in one line').fill(title);
    await expect(page.getByText('Will create')).toBeVisible();
    const firstRetry = page.waitForEvent('requestfailed', (r) => r.url().includes('/api/pwa/captures'));
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Saved on this device/)).toBeVisible();
    await expect(page.getByText('1 capture waiting to sync')).toBeVisible();
    await firstRetry; // the automatic retry also failed: the capture stays queued
    await expect(page.getByText('1 capture waiting to sync')).toBeVisible();
    await page.unrouteAll();
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect(page.getByText('1 offline capture synced')).toBeVisible();
    expect(await exactMatches(page, title)).toBe(1);
  });
});

test('opening the app while offline shows the fallback page, which can still queue a capture', async ({ page, context }) => {
  await signIn(page, 'dev');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => !!navigator.serviceWorker.controller && !!(await caches.match('/offline.html')))).toBe(true);
  await context.setOffline(true);
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible();
  const title = `Cold start offline capture ${Date.now().toString(36)}`;
  await page.getByLabel(/Capture a task/).fill(`${title} today`);
  await page.getByRole('button', { name: 'Save on this device' }).click();
  await expect(page.getByText(/1 capture waiting to sync/)).toBeVisible();
  expect(await axeSerious(page)).toEqual([]);
  await context.setOffline(false); // the fallback page reloads into the app, which syncs the queued capture
  await expect(page.getByText('1 offline capture synced')).toBeVisible();
  expect(await exactMatches(page, title)).toBe(1);
  expect(await outboxCount(page)).toBe(0);
});

test('client accounts get no offline capture on the fallback page', async ({ page, context }) => {
  await page.goto('/login');
  await page.evaluate(() => localStorage.setItem('tt-outbox-user', 'left-by-a-staff-session')); // e.g. a session that expired on this device
  await signIn(page, 'lena', 'globex.example');
  await page.goto('/portal');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => localStorage.getItem('tt-outbox-user') === null && !!navigator.serviceWorker.controller
    && !!(await caches.match('/offline.html')))).toBe(true);
  await context.setOffline(true);
  await expect(page.getByText('Reconnect to see the latest project updates.')).toBeVisible(); // clients have no quick capture to offer
  await expect(page.getByText(/Quick capture still works/)).toHaveCount(0);
  await page.goto('/portal');
  await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible();
  await expect(page.getByLabel(/Capture a task/)).toBeHidden();
  await context.setOffline(false);
});

test.describe('outbox safety', () => {
  test.use({ serviceWorkers: 'block' }); // so page.route sees every request
  test('a capture the server keeps failing on never blocks the others and can be discarded', async ({ page, context }) => {
    await signIn(page, 'kabir');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const stamp = Date.now().toString(36);
    const bad = `Server rejects this capture ${stamp}`, good = `Healthy capture ${stamp}`;
    await context.setOffline(true);
    await expect(page.getByText("You're offline.")).toBeVisible();
    await captureOffline(page, bad); // queued first, so it is sent first
    await captureOffline(page, good);
    await expect(page.getByText('2 captures waiting to sync')).toBeVisible();
    await page.route('**/api/pwa/captures', (r) => (r.request().postDataJSON().text === bad
      ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal', message: 'Something went wrong on the server.' }) })
      : r.continue()));
    await context.setOffline(false);
    await expect.poll(() => exactMatches(page, good)).toBe(1); // the failing capture ahead of it did not hold it back
    await expect(page.getByText('1 capture waiting to sync')).toBeVisible();
    const syncNow = page.getByRole('button', { name: 'Sync now' });
    await expect.poll(async () => {
      if (await syncNow.isVisible() && await syncNow.isEnabled()) await syncNow.click();
      return page.getByText('1 capture needs attention').isVisible();
    }, { timeout: 20_000 }).toBe(true);
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    const field = page.getByRole('list', { name: 'Captures that need attention' }).getByRole('textbox');
    await expect(field).toHaveValue(bad);
    await expect(field).toHaveAccessibleDescription(/could not create this capture/);
    expect(await axeSerious(page)).toEqual([]);
    // Discarding deletes the text for good, so it asks first; Keep returns focus to Discard.
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.getByText('Delete this capture from this device?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep' })).toBeFocused();
    expect(await axeSerious(page)).toEqual([]);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Discard', exact: true })).toBeFocused();
    expect(await outboxCount(page)).toBe(1);
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('button', { name: 'Discard capture' }).click();
    await expect(page.getByText('needs attention')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Connection and sync status' })).toBeFocused(); // focus is not dropped to the page body
    expect(await outboxCount(page)).toBe(0);
    expect(await exactMatches(page, bad)).toBe(0);
  });

  test('signing out asks first, needs a connection, then deletes the outbox', async ({ page, context }) => {
    await signIn(page, 'meera');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const dialogs: string[] = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
    await context.setOffline(true);
    await expect(page.getByText("You're offline.")).toBeVisible();
    await captureOffline(page, `Never synced capture ${Date.now().toString(36)}`);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect.poll(() => dialogs.length).toBe(2);
    expect(dialogs[0]).toMatch(/1 quick capture on this device has not synced yet/);
    expect(dialogs[1]).toMatch(/Signing out needs a connection/);
    await expect(page).not.toHaveURL(/\/login/);
    expect(await outboxCount(page)).toBe(1); // nothing deleted while the session could not be ended

    await page.route('**/api/pwa/captures', (r) => r.abort('internetdisconnected')); // keep it unsynced
    await context.setOffline(false);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(dialogs).toHaveLength(3);
    expect(await outboxCount(page)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('tt-outbox-user'))).toBeNull();
  });
});

test('mobile bottom navigation at 390px', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signIn(page, 'rahul');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const bar = page.getByRole('navigation', { name: 'Mobile' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('link', { name: 'My Day' })).toHaveAttribute('aria-current', 'page');
  await bar.getByRole('link', { name: 'Tasks' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(bar.getByRole('link', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page');
  await bar.getByRole('link', { name: 'Recap' }).click();
  await expect(page).toHaveURL(/\/recap$/);
  // More opens the full navigation as a dialog: focus moves in, Escape closes it and returns focus.
  await bar.getByRole('button', { name: 'More' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer.getByRole('link', { name: 'Daily recap' })).toBeFocused();
  await expect(bar.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'true');
  expect(await axeSerious(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'More' })).toBeFocused();
  await bar.getByRole('button', { name: 'More' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Projects' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  // Fits the phone and never hides the end of the page behind the bar.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const [pad, barHeight] = await page.evaluate(() => [parseFloat(getComputedStyle(document.getElementById('main')!).paddingBottom),
    document.querySelector('nav[aria-label="Mobile"]')!.getBoundingClientRect().height]);
  expect(pad).toBeGreaterThanOrEqual(barHeight);
  expect(await axeSerious(page)).toEqual([]);
  await bar.getByRole('button', { name: 'Quick capture' }).click();
  await expect(page.getByLabel('Describe the task in one line')).toBeFocused();
  await ctx.close();
});

test('bottom navigation is hidden on desktop', async ({ page }) => {
  await signIn(page, 'rahul');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeHidden();
});

test('voice capture: hidden unless enabled by the organization and supported by the browser', async ({ page, browser }) => {
  // Disabled (default): no microphone, even where the browser supports speech recognition.
  await page.addInitScript(fakeSpeech);
  await signIn(page, 'asha');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('q');
  await expect(page.getByLabel('Describe the task in one line')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dictate with voice' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  expect((await api(page, 'PATCH', '/api/admin/tenant', { settings: { voice_capture_enabled: true } })).status).toBe(200);
  try {
    // Enabled + a browser with speech recognition (a stand-in that "hears" one phrase): transcript goes to the parser for confirmation.
    const ctx = await browser.newContext();
    await ctx.addInitScript(fakeSpeech);
    const p2 = await ctx.newPage();
    await signIn(p2, 'sara');
    await expect(p2.getByRole('heading', { level: 1 })).toBeVisible();
    await p2.keyboard.press('q');
    await expect(p2.getByText(/this app never receives or stores audio/)).toBeVisible();
    await p2.getByRole('button', { name: 'Dictate with voice' }).click();
    await expect(p2.getByLabel('Describe the task in one line')).toHaveValue('Call the venue about seating tomorrow 15m');
    await expect(p2.getByText('Will create')).toBeVisible();
    await expect(p2.getByText('Call the venue about seating', { exact: true })).toBeVisible();
    expect(await axeSerious(p2)).toEqual([]);
    // Browser speech recognition needs its online service: offline, the microphone and its notice go away and the offline note explains.
    await ctx.setOffline(true);
    await expect(p2.getByRole('button', { name: 'Dictate with voice' })).toHaveCount(0);
    await expect(p2.getByText(/this app never receives or stores audio/)).toHaveCount(0);
    await expect(p2.getByText(/This capture is kept on this device/)).toBeVisible();
    await ctx.setOffline(false);
    await ctx.close();

    // Enabled but the browser has no speech recognition: no button.
    const ctx2 = await browser.newContext();
    await ctx2.addInitScript(() => { delete (window as any).webkitSpeechRecognition; delete (window as any).SpeechRecognition; });
    const p3 = await ctx2.newPage();
    await signIn(p3, 'sara');
    await expect(p3.getByRole('heading', { level: 1 })).toBeVisible();
    await p3.keyboard.press('q');
    await expect(p3.getByLabel('Describe the task in one line')).toBeVisible();
    await expect(p3.getByRole('button', { name: 'Dictate with voice' })).toHaveCount(0);
    await ctx2.close();
  } finally {
    await api(page, 'PATCH', '/api/admin/tenant', { settings: { voice_capture_enabled: false } });
  }
});

test('update prompt: a newer deployment offers Reload or Later', async ({ page }) => {
  await signIn(page, 'priya');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Pretend the server now serves a newer build (different hashed entry script).
  await page.route(/\/$/, async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, body: (await res.text()).replace(/\/assets\/index-[^"]+\.js/, '/assets/index-NEWBUILD.js') });
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const status = page.getByRole('region', { name: 'Connection and sync status' });
  await expect(status.getByText('A new version of the app is available.')).toBeVisible();
  await expect(status.getByRole('button', { name: 'Reload' })).toBeVisible();
  expect(await axeSerious(page)).toEqual([]);
  await status.getByRole('button', { name: 'Later' }).click();
  await expect(page.getByText('A new version of the app is available.')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Connection and sync status' })).toHaveCount(0); // no empty landmark left behind
});

test('phone in dark mode: offline capture from the bottom bar, then the offline page', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await signIn(page, 'sara');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => !!navigator.serviceWorker.controller && !!(await caches.match('/offline.html')))).toBe(true);
  await ctx.setOffline(true);
  await expect(page.getByText("You're offline.")).toBeVisible();
  const bar = page.getByRole('navigation', { name: 'Mobile' });
  await bar.getByRole('button', { name: 'Quick capture' }).click();
  await expect(page.getByText(/This capture is kept on this device/)).toBeVisible(); // said up front, before anything is typed
  await page.getByLabel('Describe the task in one line').fill(`Phone capture ${Date.now().toString(36)}`);
  expect(await axeSerious(page)).toEqual([]);
  await page.getByRole('button', { name: 'Save offline' }).click();
  await expect(page.getByText('1 capture waiting to sync')).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Quick capture' })).toContainText('1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(await axeSerious(page)).toEqual([]);

  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible();
  await expect(page.getByText('1 capture waiting to sync')).toBeVisible();
  await page.getByRole('button', { name: 'Save on this device' }).click(); // empty: the browser asks for text instead of saving nothing
  await expect(page.getByLabel(/Capture a task/)).toBeFocused();
  await expect(page.getByText('1 capture waiting to sync')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(await axeSerious(page)).toEqual([]);
  await ctx.setOffline(false);
  await expect(page.getByText('1 offline capture synced')).toBeVisible();
  await ctx.close();
});
