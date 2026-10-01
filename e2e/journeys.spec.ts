import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { signIn } from './helpers';

const timings: Record<string, number> = {};
test.afterAll(() => { mkdirSync('test-results', { recursive: true }); writeFileSync('test-results/routine-timings.json', JSON.stringify(timings, null, 2)); });

test('employee daily routine: plan 3 outcomes, quick capture, inline update, confirm recap', async ({ page }) => {
  await signIn(page, 'sara');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const t0 = Date.now();
  // Start of day: pick up to three outcomes from suggestions
  const outcomes = page.locator('ol li').filter({ hasText: /./ });
  for (let i = 0; i < 3; i++) {
    const chip = page.getByRole('button', { name: /^Add ".*" to today$/ }).first();
    if (!(await chip.isVisible().catch(() => false))) break;
    await chip.click();
    await page.waitForResponse((r) => r.url().includes('/api/my-day/plan') && r.ok());
  }
  await expect(page.getByText(/\/3$/)).toHaveText(/[1-3]\/3/);
  const tPlan = Date.now();
  // During work: one-line capture
  await page.keyboard.press('q');
  await page.getByLabel('Describe the task in one line').fill('Review tracking page copy tomorrow 20m !low');
  await expect(page.getByText('Will create')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Created "Review tracking page copy"/)).toBeVisible();
  // Inline status update on the first intended outcome
  const statusBtn = page.getByRole('button', { name: /^Status: (Planned|In Progress)/ }).first();
  await statusBtn.click();
  await page.getByRole('menuitem', { name: /In Progress|Planned/ }).first().click();
  await expect(page.getByText(/Moved to/)).toBeVisible();
  const tWork = Date.now();
  // End of day: review suggested summary and confirm
  await page.getByRole('link', { name: /End-of-day recap/ }).click();
  await expect(page.getByRole('heading', { name: 'Your recap' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm recap' }).click();
  await expect(page.getByText(/Recap confirmed/)).toBeVisible();
  const tEnd = Date.now();
  timings.plan_ms = tPlan - t0; timings.during_work_ms = tWork - tPlan; timings.recap_ms = tEnd - tWork; timings.total_ms = tEnd - t0;
  expect(tEnd - t0).toBeLessThan(120_000);
  await expect(page.getByText(/Confirmed · v1/)).toBeVisible();
  void outcomes;
});

test('main admin reviews every employee routine and drills down', async ({ page }) => {
  await signIn(page, 'asha');
  await page.getByRole('link', { name: 'Daily Routine' }).click();
  await expect(page.getByRole('heading', { name: 'Daily routine' })).toBeVisible();
  await expect(page.getByText('Main administrator · company-wide')).toBeVisible();
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(8);
  // Filter by department
  await page.getByLabel('Department').selectOption({ label: 'Engineering' });
  await expect(rows).toHaveCount(3);
  await page.getByRole('link', { name: /Sara Khan/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Sara Khan' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recorded routine' })).toBeVisible();
  await page.getByRole('button', { name: 'Ask to clarify' }).click();
  await page.getByLabel('Your question').fill('Which copy changes were requested?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(/employee has been notified/)).toBeVisible();
  await expect(page.getByText('Which copy changes were requested?')).toBeVisible();
});

test('team manager stays team-scoped; employees cannot open the routine view', async ({ page }) => {
  await signIn(page, 'priya');
  await page.getByRole('link', { name: 'Team routine' }).click();
  await expect(page.getByText('Team manager · your teams')).toBeVisible();
  const names = await page.locator('tbody tr td:first-child').allInnerTexts();
  expect(names.join(' ')).not.toMatch(/Asha|Vikram|Kabir/);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'rahul');
  await expect(page.getByRole('link', { name: /routine/i })).toHaveCount(0);
  await page.goto('/admin/routine');
  await expect(page.getByText(/Only the main administrator and team managers/)).toBeVisible();
});

test('individual report: period switch, explainable label and PDF export', async ({ page }) => {
  await signIn(page, 'meera');
  await page.getByRole('link', { name: 'My Analytics' }).click();
  await expect(page.getByText('Supporting facts')).toBeVisible();
  await page.getByRole('radio', { name: 'Month' }).click();
  await expect(page.getByText(/Logging coverage/).first()).toBeVisible();
  await page.getByRole('radio', { name: 'Table' }).click();
  await expect(page.locator('table')).toContainText('Unknown');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF' }).click();
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/^report-meera-iyer-.*\.pdf$/);
});

test('board: keyboard drag moves a card between columns', async ({ page }) => {
  await signIn(page, 'dev');
  await page.goto('/tasks?view=board&mine=1');
  const planned = page.getByRole('region', { name: 'Planned column' });
  const card = planned.locator('li').first();
  const title = (await card.locator('button').first().innerText()).trim();
  await card.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  await page.keyboard.press('Space');
  await expect(page.getByRole('region', { name: 'In Progress column' })).toContainText(title, { timeout: 10_000 });
});

test('client portal shows only shared work', async ({ page }) => {
  await signIn(page, 'lena', 'globex.example');
  await expect(page).toHaveURL(/\/(portal)?$/);
  await page.goto('/portal');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await expect(page.getByText('Globex portal v2')).toBeVisible();
  await expect(page.getByRole('link', { name: 'My Day' })).toHaveCount(0);
  await expect(page.getByText(/Office procurement|Q3 close/)).toHaveCount(0);
});

for (const path of ['/', '/tasks', '/recap', '/analytics', '/admin/routine', '/capacity', '/leadership']) {
  test(`accessibility: no serious or critical axe violations on ${path}`, async ({ page }) => {
    await signIn(page, 'asha');
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
    expect(bad.map((v) => `${v.id}: ${v.nodes.length} nodes — ${v.help}`)).toEqual([]);
  });
}

test('mobile: My Day fits a phone screen and quick capture is reachable', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signIn(page, 'kabir');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Quick capture' }).last().click();
  await expect(page.getByLabel('Describe the task in one line')).toBeFocused();
  await ctx.close();
});
