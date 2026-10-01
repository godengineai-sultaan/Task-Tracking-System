import { test, expect, request, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

const FEED = /\/calendar-feed\/[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}\.ics$/;

async function noSeriousAxe(page: Page) {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(bad.map((v) => `${v.id}: ${v.nodes.length} nodes — ${v.help}`)).toEqual([]);
}

test('calendar feed: create, rotate (old address stops working) and revoke', async ({ page }) => {
  const anon = await request.newContext(); // no session: the feed is authenticated by its secret address only
  await signIn(page, 'dev');
  await page.goto('/integrations');
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Calendar feed' }) });
  await card.getByRole('button', { name: 'Create feed address' }).click();
  const addr = card.getByLabel('Your feed address');
  await expect(addr).toHaveValue(FEED);
  const first = await addr.inputValue();
  const r1 = await anon.get(first);
  expect(r1.status()).toBe(200);
  expect(r1.headers()['content-type']).toContain('text/calendar');
  expect(r1.headers()['cache-control']).toContain('private');
  expect(await r1.text()).toContain('BEGIN:VCALENDAR');
  await noSeriousAxe(page);

  await card.getByRole('button', { name: 'Rotate address' }).click();
  await page.getByRole('dialog', { name: 'Rotate feed address?' }).getByRole('button', { name: 'Rotate', exact: true }).click();
  await expect(addr).not.toHaveValue(first);
  await expect(addr).toHaveValue(FEED);
  const second = await addr.inputValue();
  expect((await anon.get(first)).status()).toBe(404);
  expect((await anon.get(second)).status()).toBe(200);

  await card.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('dialog', { name: 'Revoke feed?' }).getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Create feed address' })).toBeVisible();
  expect((await anon.get(second)).status()).toBe(404);
  await anon.dispose();
});

test('holidays: import from an uploaded file with preview, then re-import is a no-op', async ({ page }) => {
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//e2e//EN',
    'BEGIN:VEVENT', 'UID:e2e-h1', 'DTSTART;VALUE=DATE:20290314', 'DTEND;VALUE=DATE:20290315', 'SUMMARY:E2E Founders Day', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:e2e-h2', 'DTSTART;VALUE=DATE:20290821', 'DTEND;VALUE=DATE:20290822', 'SUMMARY:E2E Harvest Day', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:e2e-t1', 'DTSTART:20290910T100000Z', 'DTEND:20290910T110000Z', 'SUMMARY:E2E timed party', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const upload = { name: 'company-holidays.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) };
  await signIn(page, 'asha');
  await page.goto('/calendar');
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Holidays', exact: true }) });

  await card.getByRole('button', { name: 'Import' }).click();
  let dlg = page.getByRole('dialog', { name: 'Import holidays' });
  await dlg.getByLabel('Calendar file (.ics)').setInputFiles(upload);
  await dlg.getByRole('button', { name: 'Preview' }).click();
  await expect(dlg.getByRole('cell', { name: 'E2E Founders Day', exact: true })).toBeVisible();
  await expect(dlg.getByRole('cell', { name: 'E2E Harvest Day', exact: true })).toBeVisible();
  await expect(dlg.getByText(/1 timed event\(s\) skipped/)).toBeVisible();
  await expect(dlg.getByText('E2E timed party')).toHaveCount(0);
  await noSeriousAxe(page);
  await dlg.getByRole('button', { name: 'Import 2 holidays' }).click();
  await expect(page.getByText('Imported 2 holidays')).toBeVisible();
  await expect(dlg).toHaveCount(0);
  await expect(card.getByText('E2E Founders Day')).toBeVisible();
  await expect(card.getByText('E2E Harvest Day')).toBeVisible();
  await expect(card.getByText('company-holidays.ics')).toBeVisible();

  // Same file again: both dates already exist, so nothing is selectable or imported.
  await card.getByRole('button', { name: 'Import' }).click();
  dlg = page.getByRole('dialog', { name: 'Import holidays' });
  await dlg.getByLabel('Calendar file (.ics)').setInputFiles(upload);
  await dlg.getByRole('button', { name: 'Preview' }).click();
  await expect(dlg.getByText(/0 new, 2 already holidays/)).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Import 0 holidays' })).toBeDisabled();
  await dlg.getByRole('button', { name: 'Close' }).click();
  await expect(card.getByText('E2E Founders Day')).toHaveCount(1);
});

test('calendar pages fit a 390px phone screen', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signIn(page, 'asha');
  for (const path of ['/integrations', '/calendar']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await ctx.close();
});

test('calendar subscription: a private address is refused with a clear message and nothing is stored', async ({ page }) => {
  await signIn(page, 'dev');
  await page.goto('/integrations');
  const sec = page.locator('section', { has: page.getByRole('heading', { name: 'Subscribe by address' }) });
  await sec.getByLabel('Secret address in iCal format').fill('https://127.0.0.1/calendar.ics');
  await sec.getByRole('button', { name: 'Subscribe' }).click();
  await expect(page.getByText(/private, local or reserved address/).first()).toBeVisible();
  const state = await page.evaluate(() => fetch('/api/calendar/subscription', { headers: { 'x-requested-with': 'fetch' } }).then((r) => r.json()));
  expect(state.subscription).toBeNull();
});
