import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

const PORTAL = 'Launch Globex customer portal v2 by November';
const STATUS = /On track|At risk|Off track|Insufficient data/;

async function api(page: Page, method: string, url: string, body?: unknown) {
  return page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u as string, { method: m as string, headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json() };
  }, [method, url, body] as const);
}
async function axeClean(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(bad.map((v) => `${v.id}: ${v.nodes.length} nodes — ${v.help}`)).toEqual([]);
}
const hOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function openObjective(page: Page, title: string) {
  await page.goto('/objectives');
  await page.getByRole('list', { name: 'Objectives' }).getByRole('link', { name: title }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

test('objective owner opens an objective, posts a check-in and sees the explained status', async ({ page }) => {
  await signIn(page, 'asha');
  await page.goto('/objectives');
  await expect(page.getByRole('heading', { level: 1, name: 'Objectives' })).toBeVisible();
  const row = page.getByRole('list', { name: 'Objectives' }).getByRole('listitem').filter({ hasText: PORTAL });
  await expect(row.getByText(STATUS)).toBeVisible();
  await openObjective(page, PORTAL);
  await expect(page.getByTestId('objective-status')).toHaveText(STATUS);
  await expect(page.getByRole('heading', { name: /^Why (on track|at risk|off track|insufficient data)$/ })).toBeVisible();
  await expect(page.getByText('Order tracking beta and client UAT signed off')).toBeVisible();
  await expect(page.getByText(/Client UAT sign-off/).first()).toBeVisible();

  await page.getByText('Facts and assumptions').click();
  await expect(page.getByText(/^Expected by elapsed time: \d+%/)).toBeVisible();
  await expect(page.getByText(/does not change the computed status/)).toBeVisible();

  const note = `E2E check-in ${Date.now()}`;
  await page.getByText('High', { exact: true }).click();
  await page.getByLabel('Note (optional)').fill(note);
  await page.getByRole('button', { name: 'Post check-in' }).click();
  await expect(page.getByText('Check-in posted')).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Check-in timeline' });
  await expect(timeline.getByRole('listitem').first()).toContainText(note);
  await expect(timeline.getByRole('listitem').first()).toContainText('Confidence 4/5');
  await page.getByRole('button', { name: 'Show table' }).click();
  await expect(page.getByRole('cell', { name: '4/5' }).first()).toBeVisible();
  // the computed status is unchanged by a check-in
  await expect(page.getByTestId('objective-status')).toHaveText(STATUS);
});

test('leadership card shows objective status and links to the detail page', async ({ page }) => {
  await signIn(page, 'asha');
  await page.goto('/leadership');
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Objectives', exact: true }) });
  await expect(card.getByText('Every October joiner productive on day one')).toBeVisible();
  await expect(card.getByText(STATUS).first()).toBeVisible();
  await card.getByRole('link', { name: 'Every October joiner productive on day one' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Every October joiner productive on day one' })).toBeVisible();
  await expect(page.getByText(/Velocity forecast/)).toBeVisible();
});

test('employees read objectives but cannot edit or check in', async ({ page }) => {
  await signIn(page, 'rahul');
  await openObjective(page, PORTAL);
  await expect(page.getByTestId('objective-status')).toHaveText(STATUS);
  await expect(page.getByRole('button', { name: 'Post check-in' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit objective' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add key result' })).toHaveCount(0);
  expect((await api(page, 'POST', '/api/objectives/create', { title: 'Not allowed' })).status).toBe(403);
});

test('leadership creates an objective, links a milestone and gets an explained status', async ({ page }) => {
  await signIn(page, 'asha');
  const projects = (await api(page, 'GET', '/api/projects')).body;
  const ops = projects.find((p: any) => p.key === 'OPS');
  const msName = `E2E milestone ${Date.now()}`;
  expect((await api(page, 'POST', `/api/projects/${ops.id}/milestones`, { name: msName })).status).toBe(200);
  await page.goto('/objectives');
  await page.getByRole('button', { name: 'New objective' }).click();
  const dialog = page.getByRole('dialog', { name: 'New objective' });
  await dialog.getByLabel('Objective', { exact: true }).fill('E2E: shorten onboarding to one week');
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  await dialog.getByLabel('Period start').fill(iso(new Date(today.getTime() - 14 * 864e5)));
  await dialog.getByLabel('Period end').fill(iso(new Date(today.getTime() + 30 * 864e5)));
  await dialog.getByRole('button', { name: 'Create objective' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'E2E: shorten onboarding to one week' })).toBeVisible();
  await expect(page.getByTestId('objective-status')).toHaveText('Insufficient data');
  await expect(page.getByText(/Progress cannot be measured yet/)).toBeVisible();
  await page.getByLabel('Milestone to link').selectOption({ label: `OPS · ${msName}` });
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.getByText('Milestone linked')).toBeVisible();
  await expect(page.getByTestId('objective-status')).toHaveText(/On track|At risk|Off track/);
  await page.getByRole('button', { name: 'Add key result' }).click();
  const kr = page.getByRole('dialog', { name: 'Add key result' });
  await kr.getByLabel('Key result').fill('Joiners rating onboarding 4+');
  await kr.getByLabel('Target').fill('10');
  await kr.getByLabel('Current (optional)').fill('5');
  await kr.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Joiners rating onboarding 4+')).toBeVisible();
  await expect(page.getByText('Reported 5 of 10.')).toBeVisible();

  // unlinking changes progress, so it asks first; Cancel keeps the link, Escape closes
  await page.getByRole('button', { name: `Unlink milestone ${msName}` }).click();
  const confirm = page.getByRole('dialog', { name: 'Unlink milestone?' });
  await expect(confirm).toContainText('stop counting toward progress');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Unlink milestone ${msName}` })).toBeVisible();
  await page.getByRole('button', { name: `Unlink milestone ${msName}` }).click();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await page.getByRole('button', { name: `Unlink milestone ${msName}` }).click();
  await axeClean(page);
  await confirm.getByRole('button', { name: 'Unlink' }).click();
  await expect(page.getByText('Milestone unlinked')).toBeVisible();
  await expect(page.getByText('No milestones linked')).toBeVisible();
});

test('keyboard only: post a check-in and read the trend as a table', async ({ page }) => {
  await signIn(page, 'asha');
  await openObjective(page, PORTAL);
  await page.getByRole('radio', { name: '1 – Very low' }).focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: '4 – High' })).toBeChecked();
  await page.keyboard.press('Tab');
  const note = `Keyboard check-in ${Date.now()}`;
  await page.keyboard.type(note);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Post check-in' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('list', { name: 'Check-in timeline' }).getByRole('listitem').first()).toContainText(note);
  // trend points are focusable and show a tooltip; the table view lists the same values
  await page.getByRole('button', { name: /confidence 4 of 5 by Asha Rao/ }).last().focus();
  await expect(page.getByRole('tooltip')).toContainText('4/5');
  await page.getByRole('button', { name: 'Show table' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('table', { name: 'Check-in confidence, newest first' })).toBeVisible();
  await axeClean(page);
});

test('status tiles filter the list and the create dialog has sensible defaults', async ({ page }) => {
  await signIn(page, 'asha');
  await page.goto('/objectives');
  const list = page.getByRole('list', { name: 'Objectives' });
  const tile = page.getByRole('group', { name: /Active objectives by status/ }).getByRole('button', { name: /Insufficient data/ });
  await tile.click();
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  await expect(list.getByRole('listitem').filter({ hasNotText: 'Insufficient data' })).toHaveCount(0);
  await expect(list.getByText('Two enterprise contracts signed this year')).toBeVisible();
  await expect(page.getByLabel('Filter by forecast status')).toHaveValue('insufficient_data');
  await tile.click();
  await expect(page.getByLabel('Filter by forecast status')).toHaveValue('');

  await page.getByRole('button', { name: 'New objective' }).click();
  const dialog = page.getByRole('dialog', { name: 'New objective' });
  await expect(dialog.getByLabel('Objective', { exact: true })).toBeFocused();
  await expect(dialog.getByLabel('Owner')).toHaveValue(await page.evaluate(async () => (await (await fetch('/api/me', { headers: { 'x-requested-with': 'fetch' } })).json()).user.id));
  await expect(dialog.getByLabel('Period start')).not.toHaveValue('');
  await expect(dialog.getByLabel('Period end')).not.toHaveValue('');
  await axeClean(page);
  // focus stays inside the dialog and Escape closes it, returning focus to the opener
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New objective' })).toBeFocused();
});

test('list shows an error with a working retry', async ({ page }) => {
  await signIn(page, 'asha');
  await page.route('**/api/objectives/overview', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Service unavailable' }) }));
  await page.goto('/objectives');
  await expect(page.getByText("Couldn't load this")).toBeVisible({ timeout: 15_000 });
  await page.unroute('**/api/objectives/overview');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('list', { name: 'Objectives' })).toBeVisible();
});

test('clients never see objectives', async ({ page }) => {
  await signIn(page, 'lena', 'globex.example');
  await page.goto('/objectives');
  await expect(page.getByText('Objectives are for staff')).toBeVisible();
  expect((await api(page, 'GET', '/api/objectives/overview')).status).toBe(403);
  await axeClean(page);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibility (${scheme}): no serious or critical axe violations on objectives views`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page, 'asha');
    await page.goto('/objectives');
    await expect(page.getByRole('list', { name: 'Objectives' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await axeClean(page);
    await openObjective(page, PORTAL);
    await page.waitForLoadState('networkidle');
    await page.getByText('Facts and assumptions').click();
    await axeClean(page);
    await page.getByRole('button', { name: 'Add key result' }).click();
    await page.getByRole('dialog', { name: 'Add key result' }).getByLabel('How it is measured').selectOption('task_completion');
    await axeClean(page);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Edit objective' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit objective' }).getByLabel('Owner')).toHaveValue(/.+/);
    await axeClean(page);
    await page.keyboard.press('Escape');
    await page.goto('/leadership');
    await expect(page.getByRole('heading', { name: 'Objectives', exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await axeClean(page);
    // employee view (read only)
    await page.context().clearCookies();
    await signIn(page, 'rahul');
    await openObjective(page, PORTAL);
    await page.waitForLoadState('networkidle');
    await axeClean(page);
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`mobile (${scheme}): objectives list, detail and leadership card fit a 390px screen`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: scheme });
    const page = await ctx.newPage();
    await signIn(page, 'asha');
    await page.goto('/objectives');
    await expect(page.getByRole('list', { name: 'Objectives' })).toBeVisible();
    expect(await hOverflow(page)).toBeLessThanOrEqual(0);
    await axeClean(page);
    await openObjective(page, PORTAL);
    await expect(page.getByTestId('objective-status')).toBeVisible();
    expect(await hOverflow(page)).toBeLessThanOrEqual(0);
    // linked tasks fit without a sideways-scrolling table
    const table = page.getByRole('table', { name: 'Tasks linked to this objective' });
    expect(await table.evaluate((t) => t.scrollWidth - t.parentElement!.clientWidth)).toBeLessThanOrEqual(0);
    await axeClean(page);
    await page.goto('/leadership');
    await expect(page.getByRole('heading', { name: 'Objectives', exact: true })).toBeVisible();
    expect(await hOverflow(page)).toBeLessThanOrEqual(0);
    await ctx.close();
  });
}
