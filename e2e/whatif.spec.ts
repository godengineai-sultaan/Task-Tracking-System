import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
async function api(page: Page, method: string, url: string, body?: unknown) {
  return page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u as string, { method: m as string, headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, body: await r.json() };
  }, [method, url, body] as const);
}

test('what-if: simulated leave makes a task slip, read-only, and the scenario can be saved and deleted', async ({ page }) => {
  await signIn(page, 'priya');
  const ctx = (await api(page, 'GET', '/api/whatif/context')).body;
  const rahul = ctx.people.find((p: any) => p.name.startsWith('Rahul'));
  expect(rahul).toBeTruthy();
  // A small task for Rahul, due well after his current queue can be finished, so it is on time in the baseline.
  const title = `What-if E2E handover ${Date.now()}`;
  const created = await api(page, 'POST', '/api/tasks', { title, ownerId: rahul.id, estimateMinutes: 60, dueDate: addDays(ctx.today, 10), priority: 'urgent' });
  expect(created.status).toBe(200);

  await page.goto('/capacity');
  await page.getByRole('link', { name: 'What-if' }).click();
  await expect(page).toHaveURL(/\/capacity\/what-if/);
  await expect(page.getByRole('heading', { name: 'What-if planner' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Rahul/ })).toBeChecked();
  await page.getByRole('radio', { name: 'All' }).click();
  const row = page.getByTestId('whatif-task-row').filter({ hasText: title });
  await expect(row).toContainText('Same finish');

  await page.getByRole('button', { name: 'Leave', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add change: Leave' });
  await dialog.getByLabel('Person').selectOption(rahul.id);
  await dialog.getByLabel('First day').fill(ctx.today);
  await dialog.getByLabel('Last day').fill(addDays(ctx.today, 13));
  await dialog.getByRole('button', { name: 'Add to scenario' }).click();
  await expect(page.getByRole('list', { name: 'Scenario changes' })).toContainText(/on leave/);

  await expect(row).toContainText('Becomes late');
  await page.getByRole('radio', { name: 'Changed' }).click();
  await expect(row).toContainText('Becomes late');
  await expect(row.getByRole('link', { name: title })).toHaveAttribute('href', `/tasks/${created.body.id}`);
  await expect(page.getByText(/would become late/)).toBeVisible();
  await expect(page.getByText(/Leave for Rahul .* removes/)).toBeVisible();

  // Nothing real changed: the task keeps its owner and due date, and Rahul has no new leave.
  const after = (await api(page, 'GET', `/api/tasks/${created.body.id}`)).body;
  expect(after.version ?? after.task?.version).toBe(created.body.version);

  // Save, reload the page, load it back, then delete.
  const name = `E2E leave ${Date.now()}`;
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByLabel('Scenario name').fill(name);
  await page.getByRole('button', { name: 'Save as new' }).click();
  await expect(page.getByText(`Saved "${name}"`)).toBeVisible();
  await page.reload();
  await page.getByLabel('Load a saved scenario').selectOption({ label: name });
  await expect(page.getByRole('list', { name: 'Scenario changes' })).toContainText(/Rahul .* on leave/);
  await page.getByRole('button', { name: `Delete scenario ${name}` }).click();
  await page.getByRole('dialog', { name: 'Delete saved scenario?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText(`Deleted "${name}"`)).toBeVisible();
  await expect(page.getByLabel('Load a saved scenario').locator('option', { hasText: name })).toHaveCount(0);
});

test('capacity page shows a projected-late column', async ({ page }) => {
  await signIn(page, 'priya');
  await page.goto('/capacity');
  await expect(page.getByRole('columnheader', { name: 'Projected late' })).toBeVisible();
  await expect(page.getByTestId('projected-late').first()).toHaveText(/\d/);
});

test('employees only plan for themselves', async ({ page }) => {
  await signIn(page, 'sara');
  await page.goto('/capacity/what-if');
  await expect(page.getByRole('heading', { name: 'What-if planner' })).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(1);
  await expect(page.getByRole('checkbox', { name: /Sara/ })).toBeChecked();
  await expect(page.getByText('Load by person')).toBeVisible();
});

test('accessibility: no serious or critical axe violations on the what-if planner', async ({ page }) => {
  await signIn(page, 'asha');
  await page.goto('/capacity/what-if');
  await expect(page.getByText('Load by person')).toBeVisible();
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(bad.map((v) => `${v.id}: ${v.nodes.length} nodes — ${v.help}`)).toEqual([]);
});

test('mobile: what-if planner fits a phone screen', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signIn(page, 'priya');
  await page.goto('/capacity/what-if');
  await expect(page.getByText('Load by person')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Allocation', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Add change: Allocation' })).toBeVisible();
  await ctx.close();
});
