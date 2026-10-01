import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

const insightsResponse = (page: any) => page.waitForResponse((r: any) => r.url().includes('/api/insights?') && r.ok());

test('main admin: company insights, filters, table view, keyboard chart reading and CSV export', async ({ page }) => {
  await signIn(page, 'asha');
  await page.getByRole('link', { name: 'Insights' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Insights' })).toBeVisible();
  await expect(page.getByText('Main administrator · company-wide')).toBeVisible();
  await expect(page.getByText('8 people in scope', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Key indicators' })).toContainText('Recap adoption');
  await expect(page.getByRole('heading', { name: 'Observations' })).toBeVisible();

  // Period: 12 weeks, then read the weekly table.
  const r12 = insightsResponse(page);
  await page.getByRole('radio', { name: '12 weeks' }).click();
  await r12;
  await expect(page).toHaveURL(/period=12/);
  await page.getByRole('radio', { name: 'Table' }).click();
  await expect(page.getByRole('table', { name: /Weekly metrics/ }).locator('tbody tr')).toHaveCount(12);

  // Department filter narrows the scope; workload stays alphabetical and labelled as load.
  const rd = insightsResponse(page);
  await page.getByLabel('Department', { exact: true }).selectOption({ label: 'Engineering' });
  await rd;
  await expect(page.getByText('3 people in scope', { exact: true })).toBeVisible();
  await expect(page.getByText(/Load, not performance/).first()).toBeVisible();
  const names = await page.getByRole('table', { name: /Workload per person/ }).locator('tbody th').allInnerTexts();
  expect(names).toEqual(['Priya Nair', 'Rahul Verma', 'Sara Khan']);

  // Back to charts: a chart is keyboard-readable week by week.
  await page.getByRole('radio', { name: 'Chart' }).click();
  const chart = page.getByRole('group', { name: /Recap adoption by week/ });
  await chart.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(chart.locator('[aria-live]')).toHaveText(/: (\d+%|Not applicable)/);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/^insights-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
});

test('team manager sees only their team and cannot widen the scope', async ({ page }) => {
  await signIn(page, 'priya');
  await page.getByRole('link', { name: 'Insights' }).click();
  await expect(page.getByText('Team manager · your teams')).toBeVisible();
  await expect(page.getByText('2 people in scope', { exact: true })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Scope' })).toHaveCount(0);
  const names = await page.getByRole('table', { name: /Workload per person/ }).locator('tbody th').allInnerTexts();
  expect(names).toEqual(['Rahul Verma', 'Sara Khan']);
  expect(await page.getByLabel('Team', { exact: true }).locator('option').allInnerTexts()).toEqual(['All my teams', 'Engineering']);
  const status = await page.evaluate(async () => (await fetch('/api/insights?scope=company', { headers: { 'x-requested-with': 'fetch' } })).status);
  expect(status).toBe(403);
});

test('leadership without the admin role gets aggregates only; small groups are withheld', async ({ page }) => {
  await signIn(page, 'vikram');
  await page.goto('/insights');
  await expect(page.getByText('Leadership · company aggregates')).toBeVisible();
  await expect(page.getByRole('table', { name: /Workload per department/ })).toBeVisible();
  await expect(page.getByRole('table', { name: /Workload per person/ })).toHaveCount(0);
  await page.getByLabel('Department', { exact: true }).selectOption({ label: 'Finance' });
  await expect(page.getByText('Withheld to protect individuals')).toBeVisible();
});

test('employees have no Insights entry and are refused', async ({ page }) => {
  await signIn(page, 'rahul');
  await expect(page.getByRole('link', { name: 'Insights' })).toHaveCount(0);
  await page.goto('/insights');
  await expect(page.getByText(/available to team managers, the main administrator and leadership/)).toBeVisible();
});

test('accessibility: no serious or critical axe violations on /insights (charts and table)', async ({ page }) => {
  await signIn(page, 'asha');
  await page.goto('/insights');
  await expect(page.getByRole('heading', { name: 'Weekly trends' })).toBeVisible();
  const check = async () => {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    return r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${v.id}: ${v.nodes.length} nodes — ${v.help}`);
  };
  expect(await check()).toEqual([]);
  await page.getByRole('radio', { name: 'Table' }).click();
  expect(await check()).toEqual([]);
});

test('mobile: Insights fits a 390px screen without horizontal page scroll', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signIn(page, 'priya');
  await page.goto('/insights');
  await expect(page.getByRole('heading', { name: 'Weekly trends' })).toBeVisible();
  await page.getByRole('radio', { name: 'Table' }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await ctx.close();
});
