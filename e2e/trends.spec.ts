import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { signIn } from './helpers';

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
/** WCAG 2 A/AA: zero serious or critical violations on the current view. */
async function expectAxeClean(page: Page, label: string) {
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

test('employee opens personal Trends: small multiples, keyboard tooltips, table, patterns, estimate accuracy', async ({ page }) => {
  await signIn(page, 'rahul');
  await page.goto('/analytics');
  await expect(page.getByText('Supporting facts')).toBeVisible();
  await page.getByRole('radio', { name: 'Trends' }).click();
  await expect(page).toHaveURL(/view=trends/);
  await expect(page.getByRole('heading', { name: 'Weekly trends' })).toBeVisible();
  await expect(page.locator('figure[data-metric]')).toHaveCount(11);
  // The leave week is explicit, not zero (on a Monday the week in progress has no completed day yet, so it is N/A too).
  await expect(page.getByText(/\b[12] Not Applicable/)).toBeVisible();
  // Headlines use the last completed week, so a half-finished week never reads as a drop.
  await expect(page.locator('figure[data-metric="focus"]')).toContainText('last full week');

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
  await expectAxeClean(page, 'charts+tooltip');

  // Focus vs meetings and estimate accuracy
  await expect(page.locator('[data-weekday="3"]')).toContainText('Wednesday');
  await page.getByRole('radio', { name: 'By project' }).click();
  await expect(page.getByRole('table', { name: 'Estimate accuracy by project' })).toContainText('Globex');

  await expectAxeClean(page, 'light 1440 charts');

  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/trends-desktop.jpg', type: 'jpeg', quality: 40, fullPage: true });

  // Table view of the same series; its scroll container is keyboard reachable
  await page.getByRole('radio', { name: 'Table' }).click();
  const table = page.getByRole('table', { name: 'Weekly trend values' });
  await expect(table).toBeVisible();
  await expect(table).toContainText('Not Applicable');
  await expect(page.getByRole('region', { name: /Weekly trend values/ })).toHaveAttribute('tabindex', '0');
  await expectAxeClean(page, 'light 1440 table');

  // Phone width: no horizontal page scroll; table and charts stay accessible
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(table).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await expectAxeClean(page, 'light 390 table');
  await page.getByRole('radio', { name: 'Charts' }).click();
  await expect(page.locator('figure[data-metric]').first()).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await expectAxeClean(page, 'light 390 charts');
  await page.screenshot({ path: 'test-results/trends-mobile.jpg', type: 'jpeg', quality: 40, fullPage: true });

  // Dark mode at both widths
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload(); // let colour transitions settle before measuring contrast
  await expect(page.locator('figure[data-metric]').first()).toBeVisible();
  await expectAxeClean(page, 'dark 390 charts');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('radio', { name: '26 wk' }).click();
  await expect(page.getByText(/26-week trends/)).toBeVisible();
  await expect(page.locator('figure[data-metric]')).toHaveCount(11);
  await expectAxeClean(page, 'dark 1440 26 weeks');
  await page.emulateMedia({ colorScheme: 'light' });

  // The existing report view is intact
  await page.getByRole('radio', { name: 'Report' }).click();
  await expect(page.getByText('Supporting facts')).toBeVisible();
});

test('Trends loading, error with retry, and empty states', async ({ page }) => {
  await signIn(page, 'rahul');
  let fail = true;
  await page.route('**/api/trends/personal**', async (route) => {
    if (fail) { await new Promise((r) => setTimeout(r, 400)); return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal', message: 'Something went wrong' }) }); }
    const res = await route.fetch(); const j = await res.json();
    j.weeks = j.weeks.map((w: any) => ({ ...w, status: 'not_applicable', naReason: 'All 5 scheduled day(s) were holidays or leave.' }));
    j.summary.applicableWeeks = 0; j.summary.notApplicableWeeks = j.weeks.length;
    j.recordsStart = '2000-01-01'; // records predate the range, so the copy explains holidays and leave
    return route.fulfill({ response: res, json: j });
  });
  await page.goto('/analytics?view=trends');
  await expect(page.getByRole('status').filter({ hasText: 'Loading trends' })).toBeAttached();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText("Couldn't load this", { timeout: 15_000 });
  await expectAxeClean(page, 'error');
  fail = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('No comparable working days in these weeks')).toBeVisible();
  await expect(page.getByText(/holiday, leave or non-working week/)).toBeVisible();
  await expectAxeClean(page, 'empty');
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
  await expectAxeClean(page, 'manager 1440');
  const rahulId = page.url().match(/analytics\/([0-9a-f-]{36})/)![1];
  await page.getByRole('radio', { name: '26 wk' }).click();
  await expect(page).toHaveURL(/weeks=26/);
  await expect(page.getByText(/26-week trends/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('figure[data-metric]').first()).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await expectAxeClean(page, 'manager 390');

  // Sara (not Rahul's manager) is refused by the server and sees an error state without a pointless Retry
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await signIn(p2, 'sara');
  const status = await p2.evaluate(async (id) => (await fetch(`/api/trends/personal?userId=${id}`, { headers: { 'x-requested-with': 'fetch' } })).status, rahulId);
  expect(status).toBe(403);
  await p2.goto(`/analytics/${rahulId}?view=trends`);
  await expect(p2.getByRole('alert')).toContainText(/not authorized|do not have access/i);
  await expect(p2.getByRole('alert').getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await ctx.close();
});
