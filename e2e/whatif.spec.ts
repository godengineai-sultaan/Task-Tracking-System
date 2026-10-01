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

async function expectAxeClean(page: Page, view: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(bad.map((v) => `${view} — ${v.id}: ${v.nodes.length} nodes — ${v.help}`)).toEqual([]);
}
async function addLeaveForRahul(page: Page, days = 13) {
  await page.getByRole('button', { name: 'Leave', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add change: Leave' });
  await dialog.getByLabel('Person').selectOption({ label: 'Rahul Verma' });
  const first = await dialog.getByLabel('First day').inputValue();
  await dialog.getByLabel('Last day').fill(addDays(first, days));
  await dialog.getByRole('button', { name: 'Add to scenario' }).click();
  await expect(page.getByRole('list', { name: 'Scenario changes' })).toContainText('Rahul Verma on leave');
  await expect(page.getByText('Updating…')).toHaveCount(0);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibility (${scheme}): results, load table, every change dialog, save and delete dialogs`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page, 'priya');
    await page.goto('/capacity');
    await expect(page.getByTestId('projected-late').first()).toHaveText(/\d/);
    await expectAxeClean(page, `capacity ${scheme}`);
    await page.getByRole('link', { name: 'What-if' }).click();
    await expect(page.getByText('Load by person')).toBeVisible();
    await addLeaveForRahul(page);
    await expect(page.getByTestId('whatif-task-row').first()).toBeVisible();
    await expectAxeClean(page, `results ${scheme}`);
    await page.getByRole('radio', { name: 'Table' }).click();
    await expect(page.getByRole('region', { name: 'Load table' })).toBeVisible();
    await expectAxeClean(page, `load table ${scheme}`);
    for (const [button, title] of [['Leave', 'Leave'], ['Reassign', 'Reassign'], ['Allocation', 'Allocation'], ['Deadline', 'Deadline'], ['New work', 'New work']]) {
      await page.getByRole('button', { name: button, exact: true }).click();
      await expect(page.getByRole('dialog', { name: `Add change: ${title}` })).toBeVisible();
      await expectAxeClean(page, `${title} dialog ${scheme}`);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    const name = `Axe ${scheme} ${Date.now()}`;
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expectAxeClean(page, `save dialog ${scheme}`);
    await page.getByLabel('Scenario name').fill(name);
    await page.getByLabel('Scenario name').press('Enter');
    await expect(page.getByText(`Saved "${name}"`)).toBeVisible();
    await page.getByRole('button', { name: `Delete scenario ${name}` }).click();
    await expect(page.getByRole('dialog', { name: 'Delete saved scenario?' })).toBeVisible();
    await expectAxeClean(page, `delete dialog ${scheme}`);
    await page.getByRole('dialog', { name: 'Delete saved scenario?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText(`Deleted "${name}"`)).toBeVisible();
    // The trash button is gone, so focus moves to the scenario picker instead of being lost.
    await expect(page.getByLabel('Load a saved scenario')).toBeFocused();
  });
}

test('keyboard only: dialogs trap focus, close on Escape and return focus; removing a change keeps focus in the card', async ({ page }) => {
  await signIn(page, 'priya');
  await page.goto('/capacity/what-if');
  await expect(page.getByText('Load by person')).toBeVisible();
  const leave = page.getByRole('button', { name: 'Leave', exact: true });
  await leave.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Add change: Leave' });
  await expect(dialog.getByLabel('Person')).toBeFocused();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(leave).toBeFocused();

  await page.keyboard.press('Enter');
  await dialog.getByLabel('Person').selectOption({ label: 'Rahul Verma' });
  await dialog.getByLabel('Last day').focus();
  await page.keyboard.press('Enter'); // submits the form
  await expect(dialog).toHaveCount(0);
  const remove = page.getByRole('button', { name: /^Remove change: Rahul Verma on leave/ });
  await expect(remove).toBeVisible();
  await remove.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('list', { name: 'Scenario changes' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Add a change' }).getByRole('button').first()).toBeFocused();

  // Chart bars expose their numbers on keyboard focus, with a visible focus ring.
  await page.getByRole('radio', { name: 'Chart' }).focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const bar = page.locator('[role=img][tabindex="0"]').first();
  await expect(bar).toBeFocused();
  await expect(bar.locator('[role=tooltip]')).toBeVisible();
  expect(await bar.evaluate((e) => getComputedStyle(e).boxShadow)).not.toBe('none');
});

test('states: results error offers retry, capacity explains a failed projection, clients are refused without a retry', async ({ page }) => {
  await signIn(page, 'priya');
  let fail = true;
  await page.route('**/api/whatif/simulate', (r) => (fail ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal', message: 'Simulated outage' }) }) : r.continue()));
  await page.goto('/capacity/what-if');
  await expect(page.getByRole('alert')).toContainText('Simulated outage');
  await expectAxeClean(page, 'results error');
  fail = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('Load by person')).toBeVisible();

  await page.getByRole('button', { name: 'None', exact: true }).click();
  await expect(page.getByText('Pick at least one person')).toBeVisible();
  await expectAxeClean(page, 'no people selected');

  fail = true;
  await page.goto('/capacity');
  await expect(page.getByRole('alert')).toContainText('Projected late counts are unavailable');
  fail = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('projected-late').first()).toHaveText(/\d/);

  await page.context().clearCookies();
  await signIn(page, 'lena', 'globex.example');
  await page.goto('/capacity/what-if');
  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
});

test('mobile: results with a change, load table and dialogs stay within a 390px screen', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: scheme });
    const page = await ctx.newPage();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await signIn(page, 'priya');
    await page.goto('/capacity');
    await expect(page.getByTestId('projected-late').first()).toHaveText(/\d/);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await expectAxeClean(page, `capacity 390 ${scheme}`);
    await page.goto('/capacity/what-if');
    await expect(page.getByText('Load by person')).toBeVisible();
    await addLeaveForRahul(page);
    await expect(page.getByTestId('whatif-task-row').first()).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await expectAxeClean(page, `results 390 ${scheme}`);
    await page.getByRole('radio', { name: 'Table' }).click();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Reassign', exact: true }).click();
    const cancel = page.getByRole('dialog', { name: 'Add change: Reassign' }).getByRole('button', { name: 'Cancel' });
    const box = (await cancel.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await cancel.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await ctx.close();
  }
});

test('employees with only themselves in scope are not offered a reassignment they cannot make', async ({ page }) => {
  await signIn(page, 'sara');
  await page.goto('/capacity/what-if');
  await expect(page.getByText('Load by person')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Add a change' }).getByRole('button')).toHaveText(['Leave', 'Allocation', 'Deadline', 'New work']);
  await expectAxeClean(page, 'employee view');
});
