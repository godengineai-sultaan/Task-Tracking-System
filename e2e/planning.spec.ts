import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

const H = { 'x-requested-with': 'fetch', 'content-type': 'application/json' };
const apiGet = (page: Page, url: string) => page.evaluate(async ([u, h]) => (await fetch(u, { headers: h })).json(), [url, H] as const);

test('plan my day: suggest with reasons and apply through the plan endpoint', async ({ page }) => {
  await signIn(page, 'vikram');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const me = await apiGet(page, '/api/me');
  // A task due today so a working day always has something to rank.
  const title = `Prepare partner pricing sheet ${Date.now() % 100000}`;
  await page.evaluate(async ([t, today, h]) => {
    const r = await fetch('/api/tasks', { method: 'POST', headers: h, body: JSON.stringify({ title: t, dueDate: today, priority: 'urgent', estimateMinutes: 30 }) });
    if (!r.ok) throw new Error(await r.text());
  }, [title, me.today, H] as const);
  await page.clock.install(); // lets the test leave My Day open for over an hour before applying
  await page.reload();

  await page.getByRole('button', { name: 'Suggest my day' }).click();
  const dialog = page.getByRole('dialog', { name: 'Suggest my day' });
  await expect(dialog).toBeVisible();
  const s = await apiGet(page, '/api/planning/suggest');
  if (!s.applicable) {
    // Zero-capacity day (weekend, holiday or leave): nothing is forced.
    await expect(dialog.getByText('Not Applicable')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Use these' })).toHaveCount(0);
    return;
  }
  await expect(dialog.getByTestId('suggest-rationale')).toContainText('scheduled time');
  await expect(dialog.getByText(/Capacity check\./)).toBeVisible();
  const ranked = dialog.getByRole('list', { name: 'Ranked candidates' });
  const row = ranked.getByRole('listitem').filter({ hasText: title });
  await expect(row.getByRole('listitem').filter({ hasText: /^Due today$/ })).toBeVisible();
  await row.getByText(/ranking points$/).click();
  await expect(row.getByRole('cell', { name: 'Due today' })).toBeVisible();
  const cb = row.getByRole('checkbox');
  if (!(await cb.isChecked())) {
    await ranked.getByRole('checkbox', { checked: true }).last().uncheck();
    await cb.check();
  }
  const a11y = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([]);

  // My Day has been open for more than an hour (for example after a "Plan your day" reminder): applying still works.
  await page.clock.fastForward('01:01:00');
  const [put] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/my-day/plan') && r.request().method() === 'PUT'),
    dialog.getByRole('button', { name: 'Use these' }).click(),
  ]);
  expect(put.ok()).toBeTruthy();
  const sent = JSON.parse(put.request().postData() ?? '{}');
  expect(sent.taskIds.length).toBeLessThanOrEqual(3);
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Planned \d intended outcome/)).toBeVisible();
  await expect(page.locator('ol').first().getByText(title)).toBeVisible();

  // Re-opening keeps the chosen outcomes and proposes nothing beyond three.
  await page.getByRole('button', { name: 'Suggest my day' }).click();
  await expect(dialog.getByRole('heading', { name: 'Already chosen (kept)' })).toBeVisible();
  await expect(dialog.getByText(title)).toBeVisible();
});

test('weekly summary: editable text, copy and week navigation', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.clock.install();
  await signIn(page, 'rahul');
  await page.getByRole('button', { name: 'Weekly summary' }).click();
  const box = page.getByLabel('Summary text');
  await expect(box).toHaveValue(/^Weekly summary: /);
  await expect(box).toHaveValue(/Accepted outcomes \(\d+\)/);
  await expect(box).toHaveValue(/Carried over \(\d+\)/);
  await expect(box).toHaveValue(/Suggested focus for next week/);
  await expect(page.getByRole('button', { name: 'Next week' })).toBeDisabled();
  await box.fill(`${await box.inputValue()}\nNote: covering support on Friday.`);
  await expect(page.getByRole('button', { name: 'Reset' })).toBeEnabled();
  // Coming back to the window refetches the summary; the edit must survive it.
  await page.clock.fastForward('00:30');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/planning/weekly-summary')),
    page.evaluate(() => window.dispatchEvent(new Event('visibilitychange'))),
  ]);
  await page.waitForTimeout(300);
  await expect(box).toHaveValue(/covering support on Friday/);
  await page.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByText('Summary copied to the clipboard')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('covering support on Friday');
  const a11y = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([]);
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(box).toHaveValue(/^Weekly summary: /);
  await expect(page.getByRole('button', { name: 'Next week' })).toBeEnabled();
});

test('planning UI fits a 390px phone and reminders can be toggled', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, 'dev');
  const plan = page.getByRole('checkbox', { name: 'Remind me to plan my day' });
  await expect(plan).toBeVisible();
  const before = await plan.isChecked();
  await plan.click();
  await expect(page.getByText('Reminder preference saved')).toBeVisible();
  await expect(plan).toBeChecked({ checked: !before });
  await plan.click();
  await expect(plan).toBeChecked({ checked: before });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Suggest my day' }).click();
  await expect(page.getByRole('dialog', { name: 'Suggest my day' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Weekly summary' }).click();
  await expect(page.getByLabel('Summary text')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
