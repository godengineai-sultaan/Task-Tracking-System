import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

const MANAGER_DAYS = "Working days before: notify the owner's team manager";

async function axeClean(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(bad.map((v) => `${v.id}: ${v.nodes.length} nodes - ${v.help} - ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} ${n.failureSummary ?? ''}`).join(' | ')}`)).toEqual([]);
}
/** Zero serious/critical axe violations in light and in dark mode. */
async function axeBothThemes(page: Page) {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    // Let colour transitions settle so axe measures the final theme, not a half-faded button.
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
    await test.step(`axe (${colorScheme})`, () => axeClean(page));
  }
  await page.emulateMedia({ colorScheme: 'light' });
}
const noPageScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function taskIdByTitle(page: Page, title: string) {
  return page.evaluate(async (t) => {
    const r = await fetch(`/api/tasks?q=${encodeURIComponent(t)}`, { headers: { 'x-requested-with': 'fetch' } });
    return (await r.json())[0].id as string;
  }, title);
}

test('admin configures the escalation ladder and reviews blocker aging', async ({ page }) => {
  await signIn(page, 'asha');
  await page.goto('/admin?tab=escalation');
  await expect(page.getByRole('heading', { name: 'Blocker escalation' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Turn on smart escalation' })).toBeChecked();
  const preview = page.getByRole('region', { name: 'What happens when a task is blocked' });
  const mgr = page.getByLabel(MANAGER_DAYS);
  await expect(mgr).toHaveValue('4');

  // Out-of-order steps are explained and cannot be saved
  await mgr.fill('1');
  await expect(page.getByText('Must be on or after the previous step')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save policy' })).toBeDisabled();

  // The plain-language preview follows the draft
  await mgr.fill('3');
  await expect(preview.getByText('After 3 working days')).toBeVisible();
  await expect(preview.getByText(/for the owner's team manager/)).toBeVisible();
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByText('Escalation policy saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(MANAGER_DAYS)).toHaveValue('3');

  // Blocker aging: company scope, sortable, no person ranking
  const table = page.getByRole('table');
  await expect(table.getByRole('link', { name: /Verify courier webhook signatures/ })).toBeVisible();
  await expect(table.getByRole('link', { name: /Chase missing vendor statement/ })).toBeVisible();
  const age = table.getByRole('columnheader', { name: /Age/ });
  await expect(age).toHaveAttribute('aria-sort', 'descending');
  const ages = async () => (await table.locator('tbody tr td:nth-child(5)').allInnerTexts()).map(Number);
  const before = await ages();
  expect(before).toEqual([...before].sort((a, b) => b - a));
  await age.getByRole('button').click();
  await expect(age).toHaveAttribute('aria-sort', 'ascending');
  const after = await ages();
  expect(after).toEqual([...after].sort((a, b) => a - b));
  // Sorting works from the keyboard too
  await table.getByRole('columnheader', { name: /Level/ }).getByRole('button').press('Enter');
  await expect(table.getByRole('columnheader', { name: /Level/ })).toHaveAttribute('aria-sort', 'descending');
  // The next escalation never names the person waited on when they are outside the app (that step is skipped, not sent)
  const external = table.getByRole('row').filter({ hasText: 'outside the app' });
  expect(await external.count()).toBeGreaterThan(0);
  for (const row of await external.all()) await expect(row.getByRole('cell').nth(7)).not.toContainText('person waited on');
  await expect(page.getByText('This lists blockers, not people.', { exact: false })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await axeBothThemes(page);
});

test('owner nudges the person waited on and sees the escalation history', async ({ page }) => {
  await signIn(page, 'rahul');
  const id = await page.evaluate(async () => {
    const r = await fetch(`/api/tasks?q=${encodeURIComponent('Verify courier webhook signatures')}`, { headers: { 'x-requested-with': 'fetch' } });
    return (await r.json())[0].id as string;
  });
  await page.goto(`/tasks/${id}`);
  const panel = page.getByTestId('blocker-escalation');
  await expect(page.getByText('Blocked · Access')).toBeVisible();
  await expect(panel.getByText(/Blocked \d+ working days?/)).toBeVisible();
  await expect(panel.getByText('Manager notified', { exact: true })).toBeVisible();

  await panel.getByRole('button', { name: /^History/ }).click();
  const history = page.getByRole('list', { name: 'Escalation history' });
  await expect(history.getByText('Team manager notified: Priya Nair')).toBeVisible();
  await expect(history.getByText('Person waited on notified: Dev Patel')).toBeVisible();

  // Keyboard: the dialog takes focus, traps Tab, closes on Escape and hands focus back
  const nudgeBtn = panel.getByRole('button', { name: 'Nudge Dev Patel' });
  await nudgeBtn.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Nudge Dev Patel' });
  await expect(dialog.getByLabel('Note (optional)')).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await axeBothThemes(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(nudgeBtn).toBeFocused();

  await nudgeBtn.click();
  await dialog.getByLabel('Note (optional)').fill('Still need the sandbox secret today, thanks!');
  await dialog.getByRole('button', { name: 'Send nudge' }).click();
  await expect(page.getByText('Nudge sent to Dev Patel')).toBeVisible();
  await expect(panel.getByText('Nudged today')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Nudge Dev Patel' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^History/ })).toBeFocused(); // focus is not lost when the button goes away
  await expect(history.getByText('Rahul Verma nudged Dev Patel').first()).toBeVisible();
  await expect(history.getByText(/Still need the sandbox secret today/)).toBeVisible();

  // Rate limit: once per day per blocker per person
  const status = await page.evaluate(async (taskId) => {
    const t = await (await fetch(`/api/tasks/${taskId}`, { headers: { 'x-requested-with': 'fetch' } })).json();
    const b = t.blockers.find((x: any) => !x.resolved_at);
    return (await fetch(`/api/blockers/${b.id}/nudge`, { method: 'POST', headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' }, body: '{}' })).status;
  }, id);
  expect(status).toBe(429);
  await axeBothThemes(page);
});

test('the person waited on is told so on the blocker, and cannot nudge themselves', async ({ page }) => {
  await signIn(page, 'dev');
  await page.goto(`/tasks/${await taskIdByTitle(page, 'Verify courier webhook signatures')}`);
  const panel = page.getByTestId('blocker-escalation');
  await expect(panel.getByText('This blocker is waiting on you.')).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Nudge/ })).toHaveCount(0);
  await axeClean(page);
});

test('manager follows a blocker to the team aging view; the policy is read-only and explained', async ({ page }) => {
  await signIn(page, 'priya');
  await page.goto(`/tasks/${await taskIdByTitle(page, 'Verify courier webhook signatures')}`);
  const panel = page.getByTestId('blocker-escalation');
  await panel.getByRole('button', { name: /^History/ }).click();
  await panel.getByRole('link', { name: 'See every open blocker in your scope' }).click();
  await expect(page).toHaveURL(/\/admin\?tab=escalation/);
  await expect(page.getByText('Open blockers on your team.')).toBeVisible();
  const table = page.getByRole('table');
  await expect(table.getByRole('link', { name: /Verify courier webhook signatures/ })).toBeVisible();
  await expect(table.getByRole('link', { name: /Chase missing vendor statement/ })).toHaveCount(0); // another team
  await expect(page.getByRole('heading', { name: 'How blocker escalation works' })).toBeVisible();
  await expect(page.getByText('Smart escalation is on')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save policy' })).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  await axeBothThemes(page);
});

test('blocker aging shows error-with-retry and empty states', async ({ page }) => {
  await signIn(page, 'asha');
  let mode: 'fail' | 'empty' | 'live' = 'fail';
  await page.route('**/api/escalation/blockers', (route) => mode === 'fail'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal', message: 'Temporary problem' }) })
    : mode === 'empty'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ scope: 'company', policy: { enabled: true, steps: [] }, summary: { open: 0, medianAgeWorkingDays: null, escalated: 0, external: 0 }, items: [] }) })
      : route.continue());
  await page.goto('/admin?tab=escalation');
  const aging = page.locator('section', { has: page.getByRole('heading', { name: 'Blocker aging' }) });
  await expect(aging.getByText("Couldn't load this")).toBeVisible({ timeout: 15_000 }); // after the query's own retries
  mode = 'empty';
  await aging.getByRole('button', { name: 'Retry' }).click();
  await expect(aging.getByText('No open blockers')).toBeVisible();
  await axeClean(page);
  mode = 'live';
  await aging.getByRole('button', { name: 'Refresh blocker aging' }).click();
  await expect(aging.getByRole('table')).toBeVisible();
});

test('client: escalation is not available and offers no pointless retry', async ({ page }) => {
  await signIn(page, 'lena', 'globex.example');
  await page.goto('/admin?tab=escalation');
  await expect(page.getByText('Not available for your account')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await axeClean(page);
});

test('mobile: escalation tab fits a phone screen', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signIn(page, 'asha');
  await page.goto('/admin?tab=escalation');
  await expect(page.getByRole('list', { name: 'Open blockers' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'What happens when a task is blocked' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByLabel('Sort by').selectOption('level:desc');
  await expect(page.getByRole('list', { name: 'Open blockers' }).getByRole('listitem').first()).toContainText('Admins notified');
  await page.waitForLoadState('networkidle');
  await axeBothThemes(page);
  await ctx.close();
});

test('mobile: blocker escalation on a task fits a phone screen', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signIn(page, 'meera');
  await page.goto(`/tasks/${await taskIdByTitle(page, 'Chase missing vendor statement')}`);
  const panel = page.getByTestId('blocker-escalation');
  await expect(panel.getByText('Admins notified', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: /^History/ }).click();
  await expect(page.getByRole('list', { name: 'Escalation history' })).toBeVisible();
  expect(await noPageScroll(page)).toBeLessThanOrEqual(0);
  await axeBothThemes(page);
  await ctx.close();
});
