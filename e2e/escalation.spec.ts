import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

const MANAGER_DAYS = "Working days before: notify the owner's team manager";

async function axeClean(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(bad.map((v) => `${v.id}: ${v.nodes.length} nodes - ${v.help}`)).toEqual([]);
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
  await expect(page.getByText('This lists blockers, not people.', { exact: false })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await axeClean(page);
});

test('owner nudges the person waited on and sees the escalation history', async ({ page }) => {
  await signIn(page, 'rahul');
  const id = await page.evaluate(async () => {
    const r = await fetch(`/api/tasks?q=${encodeURIComponent('Verify courier webhook signatures')}`, { headers: { 'x-requested-with': 'fetch' } });
    return (await r.json())[0].id as string;
  });
  await page.goto(`/tasks/${id}`);
  const panel = page.getByTestId('blocker-escalation');
  await expect(panel.getByText(/Blocked \d+ working days?/)).toBeVisible();
  await expect(panel.getByText('Manager notified', { exact: true })).toBeVisible();

  await panel.getByRole('button', { name: /^History/ }).click();
  const history = page.getByRole('list', { name: 'Escalation history' });
  await expect(history.getByText('Team manager notified: Priya Nair')).toBeVisible();
  await expect(history.getByText('Person waited on notified: Dev Patel')).toBeVisible();

  await panel.getByRole('button', { name: 'Nudge Dev Patel' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nudge Dev Patel' });
  await dialog.getByLabel('Note (optional)').fill('Still need the sandbox secret today, thanks!');
  await dialog.getByRole('button', { name: 'Send nudge' }).click();
  await expect(page.getByText('Nudge sent to Dev Patel')).toBeVisible();
  await expect(panel.getByText('Nudged today')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Nudge Dev Patel' })).toHaveCount(0);
  await expect(history.getByText('Rahul Verma nudged Dev Patel').first()).toBeVisible();
  await expect(history.getByText(/Still need the sandbox secret today/)).toBeVisible();

  // Rate limit: once per day per blocker per person
  const status = await page.evaluate(async (taskId) => {
    const t = await (await fetch(`/api/tasks/${taskId}`, { headers: { 'x-requested-with': 'fetch' } })).json();
    const b = t.blockers.find((x: any) => !x.resolved_at);
    return (await fetch(`/api/blockers/${b.id}/nudge`, { method: 'POST', headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' }, body: '{}' })).status;
  }, id);
  expect(status).toBe(429);
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
  await ctx.close();
});
