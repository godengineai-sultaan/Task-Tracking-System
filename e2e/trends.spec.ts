import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { signIn } from './helpers';

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('employee opens personal Trends: small multiples, keyboard tooltips, table, patterns, estimate accuracy', async ({ page }) => {
  await signIn(page, 'rahul');
  await page.goto('/analytics');
  await expect(page.getByText('Supporting facts')).toBeVisible();
  await page.getByRole('radio', { name: 'Trends' }).click();
  await expect(page).toHaveURL(/view=trends/);
  await expect(page.getByRole('heading', { name: 'Weekly trends' })).toBeVisible();
  await expect(page.locator('figure[data-metric]')).toHaveCount(11);
  await expect(page.getByText(/1 Not Applicable/)).toBeVisible(); // the leave week is explicit, not zero

  // Pattern review: explainable, with facts and a suggestion
  const meetings = page.locator('[data-pattern="meetings-weekday-3"]');
  await expect(meetings).toContainText(/Meetings took over 50% of available time on \d of the last \d Wednesdays/);
  await expect(meetings).toContainText('Facts');
  await expect(page.locator('[data-pattern="estimate-category-research"]')).toContainText(/Tasks in Research run \d\.\dx their estimates on average \(\d+ tasks\)/);

  // One tab stop per chart; arrow keys read each week through the tooltip
  const chart = page.getByRole('group', { name: /^Focus time by week/ });
  await chart.focus();
  await expect(page.getByRole('tooltip')).toContainText('Week of');
  await page.keyboard.press('Home');
  await expect(page.getByRole('tooltip')).toContainText('Week of');

  // Focus vs meetings and estimate accuracy
  await expect(page.locator('[data-weekday="3"]')).toContainText('Wednesday');
  await page.getByRole('radio', { name: 'By project' }).click();
  await expect(page.getByRole('table', { name: 'Estimate accuracy by project' })).toContainText('Globex');

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);

  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/trends-desktop.jpg', type: 'jpeg', quality: 40, fullPage: true });

  // Table view of the same series
  await page.getByRole('radio', { name: 'Table' }).click();
  const table = page.getByRole('table', { name: 'Weekly trend values' });
  await expect(table).toBeVisible();
  await expect(table).toContainText('Not Applicable');

  // Phone width: no horizontal page scroll
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('radio', { name: 'Charts' }).click();
  await expect(page.locator('figure[data-metric]').first()).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: 'test-results/trends-mobile.jpg', type: 'jpeg', quality: 40, fullPage: true });

  // The existing report view is intact
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('radio', { name: 'Report' }).click();
  await expect(page.getByText('Supporting facts')).toBeVisible();
});

test('manager opens Trends for a team member; employees cannot open someone else\'s trends', async ({ page, browser }) => {
  await signIn(page, 'priya');
  await page.goto('/analytics?view=trends');
  await expect(page.getByRole('heading', { name: 'Weekly trends' })).toBeVisible();
  await page.getByLabel('Person').selectOption({ label: 'Rahul Verma' });
  await expect(page).toHaveURL(/\/analytics\/[0-9a-f-]{36}\?.*view=trends/);
  await expect(page.getByRole('heading', { level: 1, name: 'Rahul Verma' })).toBeVisible();
  await expect(page.locator('[data-pattern="meetings-weekday-3"]')).toBeVisible();
  await expect(page.locator('figure[data-metric]')).toHaveCount(11);
  const rahulId = page.url().match(/analytics\/([0-9a-f-]{36})/)![1];
  await page.getByRole('radio', { name: '26 wk' }).click();
  await expect(page).toHaveURL(/weeks=26/);
  await expect(page.getByText(/26-week trends/)).toBeVisible();

  // Sara (not Rahul's manager) is refused by the server and sees an error state
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await signIn(p2, 'sara');
  const status = await p2.evaluate(async (id) => (await fetch(`/api/trends/personal?userId=${id}`, { headers: { 'x-requested-with': 'fetch' } })).status, rahulId);
  expect(status).toBe(403);
  await p2.goto(`/analytics/${rahulId}?view=trends`);
  await expect(p2.getByRole('alert')).toContainText(/not authorized/i);
  await ctx.close();
});
