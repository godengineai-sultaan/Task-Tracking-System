import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

const getJson = (page: Page, url: string) => page.evaluate(async (u) => {
  const r = await fetch(u, { headers: { 'x-requested-with': 'fetch' } });
  return { status: r.status, body: await r.json() };
}, url);
const projectId = async (page: Page, key: string) => (await getJson(page, '/api/projects')).body.find((p: any) => p.key === key).id as string;
const axe = async (page: Page) => {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  return r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${v.id}: ${v.nodes.length} nodes — ${v.help}`);
};

test('cost viewer sets a budget on a project and sees consumption', async ({ page }) => {
  await signIn(page, 'asha');
  const id = await projectId(page, 'SALES');
  await page.goto(`/projects/${id}`);
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Budget', exact: true }) });
  await expect(card.getByText(/No budget set/)).toBeVisible();
  await card.getByRole('button', { name: 'Set budget' }).click();
  const dialog = page.getByRole('dialog', { name: 'Set budget' });
  await dialog.getByLabel('Billing').selectOption('fixed_fee');
  await dialog.getByLabel('Fixed fee').fill('200000');
  await dialog.getByLabel('Budget hours').fill('100');
  await dialog.getByRole('button', { name: 'Save budget' }).click();
  await expect(page.getByText('Budget saved')).toBeVisible();
  const api = (await getJson(page, `/api/projects/${id}/budget`)).body;
  expect(api.budget).toMatchObject({ billingType: 'fixed_fee', budgetAmount: 200000, budgetHours: 100 });
  const amountPct = `${Math.round(api.money.consumption * 100)}% used`;
  await expect(card.getByRole('img', { name: new RegExp(`^Budget amount: ${amountPct}`) })).toBeVisible();
  await expect(card.getByRole('img', { name: new RegExp(`^Budgeted hours: ${Math.round(api.hours.consumption * 100)}% used`) })).toBeVisible();
  await expect(card.getByText('Cost vs budget')).toBeVisible();
  await expect(card.getByText('Margin', { exact: true })).toBeVisible();
  // Hover/focus tooltip on the bar
  await card.getByRole('img', { name: /^Budget amount/ }).focus();
  await expect(card.getByText(new RegExp(`Budget amount: ${amountPct}`)).first()).toBeVisible();
  // Explanation of facts and assumptions
  await card.getByText('How this is calculated').click();
  await expect(card.getByText(/priced at each person's cost rate effective on the entry date/)).toBeVisible();
  expect(await axe(page)).toEqual([]);

  // Portfolio shows it, with filters and sorting
  await page.goto('/profitability');
  await expect(page.getByRole('heading', { name: 'Profitability', level: 1 })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'Enterprise pipeline' });
  await expect(row.getByText('Fixed fee')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Totals per currency' })).toBeVisible();
  await page.getByLabel('Filter by budget status').selectOption('over_budget');
  await expect(page.getByRole('row').filter({ hasText: 'Q3 close' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Enterprise pipeline' })).toHaveCount(0);
  await page.getByLabel('Filter by budget status').selectOption('');
  await page.getByRole('button', { name: 'Margin' }).click();
  await expect(page.getByRole('table', { name: /Project budgets/ }).getByRole('columnheader', { name: 'Margin' })).toHaveAttribute('aria-sort', 'descending');
  expect(await axe(page)).toEqual([]);

  // Projects list shows a budget chip
  await page.goto('/projects');
  await expect(page.getByRole('link', { name: /Enterprise pipeline/ }).getByText(/^Budget \d+%$/)).toBeVisible();
});

test('project owner without cost access sees hours only; employees see nothing', async ({ page }) => {
  await signIn(page, 'priya');
  const id = await projectId(page, 'WEB');
  await page.goto(`/projects/${id}`);
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Budget', exact: true }) });
  await expect(card.getByText(/Hours view\. Money figures are visible to cost viewers only/)).toBeVisible();
  await expect(card.getByText('Hours vs budget')).toBeVisible();
  await expect(card.getByText('Cost vs budget')).toHaveCount(0);
  await expect(card.getByRole('button', { name: /Set budget|Edit/ })).toHaveCount(0);
  expect(await card.innerText()).not.toMatch(/₹|INR|Cost to date|Margin/);
  const api = await getJson(page, `/api/projects/${id}/budget`);
  expect(api.body.money).toBeNull();

  await page.context().clearCookies();
  await signIn(page, 'rahul');
  await page.goto('/profitability');
  await expect(page.getByText('Budgets are not shared with you')).toBeVisible();
  await page.goto(`/projects/${id}`);
  await expect(page.getByRole('heading', { name: 'Milestones' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toHaveCount(0);
});

test('profitability page fits a phone screen', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signIn(page, 'asha');
  await page.goto('/profitability');
  await expect(page.getByRole('heading', { name: 'Profitability', level: 1 })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Project budgets' }).getByRole('listitem').filter({ hasText: 'Q3 close' })).toBeVisible();
  await expect(page.getByRole('table', { name: /Project budgets/ })).toBeHidden();
  await page.getByLabel('Sort projects').selectOption('name:asc');
  const items = await page.getByRole('list', { name: 'Project budgets' }).getByRole('listitem').allInnerTexts();
  const at = (t: string) => items.findIndex((x) => x.includes(t));
  expect(at('Enterprise pipeline')).toBeGreaterThanOrEqual(0);
  expect(at('Enterprise pipeline')).toBeLessThan(at('Q3 close'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.goto(`/projects/${await projectId(page, 'OPS')}`);
  await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await ctx.close();
});
