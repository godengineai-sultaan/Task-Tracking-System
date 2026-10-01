import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

// Fixtures: the fictional 'lord' organization seeded by server/src/cli/seed-lord.ts.
const VIDYA_TASK = 'Ingest Maharashtra Board Class 9 science revisions';
const RUNTIME_TASK = 'GPU node autoscaling policy';
const COMPANY_TASK = 'Quarterly GST filing for both entities';
const HRMS_TASK = 'Statutory deductions rules engine (PF / ESI)';

const lord = (page: Page, who: string) => signIn(page, who, 'lord.example', 'lord');
async function axeClean(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(bad.map((v) => `${v.id}: ${v.nodes.length} nodes — ${v.help}`)).toEqual([]);
}
const switcher = (page: Page) => page.getByRole('button', { name: /^Product scope:/ });
const taskList = (page: Page) => page.locator('main');

test('a product lead switches products from the header and the task list follows', async ({ page }) => {
  await lord(page, 'nisha');
  await page.goto('/tasks');
  await expect(taskList(page).getByText(VIDYA_TASK)).toBeVisible();
  await expect(taskList(page).getByText(RUNTIME_TASK)).toBeVisible();     // company-visible platform product
  await expect(taskList(page).getByText(COMPANY_TASK)).toBeVisible();     // company-wide work
  await expect(switcher(page)).toHaveAccessibleName('Product scope: All products');

  // Keyboard: open, filter, choose.
  await switcher(page).focus();
  await page.keyboard.press('Enter');
  const box = page.getByRole('combobox', { name: 'Find a product' });
  await expect(box).toBeFocused();
  await expect(page.getByRole('listbox', { name: 'Product scope' }).getByRole('option', { name: /^HRMS/ })).toHaveCount(0); // not in her scope
  await axeClean(page);
  await box.fill('Vidya AI');
  await page.keyboard.press('ArrowDown');
  await expect(box).toHaveAttribute('aria-activedescendant', /.+/);
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(switcher(page)).toBeFocused();
  await expect(switcher(page)).toHaveAccessibleName('Product scope: Vidya AI');
  await expect(page.getByTestId('scope-chip')).toContainText('Vidya AI workspace');
  await expect(taskList(page).getByText(VIDYA_TASK)).toBeVisible();
  await expect(taskList(page).getByText(RUNTIME_TASK)).toHaveCount(0);
  await expect(taskList(page).getByText(COMPANY_TASK)).toHaveCount(0);

  // Mouse: company-wide work only.
  await switcher(page).click();
  await page.getByRole('option', { name: /^Company-wide work/ }).click();
  await expect(taskList(page).getByText(COMPANY_TASK)).toBeVisible();
  await expect(taskList(page).getByText(VIDYA_TASK)).toHaveCount(0);
  await expect(page.getByTestId('scope-chip')).toContainText('Company-wide work');

  // Remembered across reloads; personal pages are not filtered and show no chip.
  await page.reload();
  await expect(switcher(page)).toHaveAccessibleName('Product scope: Company-wide work');
  await page.goto('/');
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await page.goto('/tasks');
  await expect(taskList(page).getByText(COMPANY_TASK)).toBeVisible();
  await page.getByRole('button', { name: 'Show all products' }).click();
  await expect(switcher(page)).toHaveAccessibleName('Product scope: All products');
  await expect(taskList(page).getByText(VIDYA_TASK)).toBeVisible();
  await expect(taskList(page).getByText(RUNTIME_TASK)).toBeVisible();
  await axeClean(page);
});

test('a person outside a product never sees it: not in the switcher, lists, search or direct requests', async ({ page }) => {
  await lord(page, 'vivek');
  await page.goto('/tasks');
  await expect(taskList(page).getByText(HRMS_TASK)).toBeVisible();
  await expect(taskList(page).getByText(VIDYA_TASK)).toHaveCount(0);
  await switcher(page).click();
  const list = page.getByRole('listbox', { name: 'Product scope' });
  await expect(list.getByRole('option', { name: /^HRMS/ })).toBeVisible();
  await expect(list.getByRole('option', { name: /^Vidya AI/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(switcher(page)).toBeFocused();
  const r = await page.evaluate(async () => {
    const get = (u: string) => fetch(u, { headers: { 'x-requested-with': 'fetch' } }).then(async (x) => ({ status: x.status, body: await x.json() }));
    const portfolio = await get('/api/portfolio');
    const search = await get('/api/search?q=Maharashtra');
    return { keys: portfolio.body.products.map((p: any) => p.key), searchTasks: search.body.tasks.length };
  });
  expect(r.keys).toContain('HRMS');
  expect(r.keys).not.toContain('VIDYA_AI');
  expect(r.searchTasks).toBe(0);
});

test('the system admin assigns a product to a company and confirms it in Administration > Portfolio', async ({ page }) => {
  await lord(page, 'founder');
  await page.goto('/admin?tab=portfolio');
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  const row = page.getByTestId('product-row-HRMS');
  await expect(row.getByText('Provisional')).toBeVisible();   // seeded provisionally by the dossier thesis
  await row.getByRole('combobox', { name: 'Company for HRMS' }).selectOption({ label: 'GOD · God Engine Private Limited' });
  await expect(page.getByText('HRMS: company set (provisional until confirmed)')).toBeVisible();
  await expect(row.getByText('Provisional')).toBeVisible();
  await row.getByRole('button', { name: 'Confirm company for HRMS' }).click();
  await expect(row.getByText('Confirmed')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Confirm company for HRMS' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Preview changes' }).click();
  await expect(page.getByTestId('provision-preview')).toContainText('Products: 32 unchanged');
  await axeClean(page);

  // The switcher groups products by company: HRMS now sits under God Engine.
  await switcher(page).click();
  const god = page.getByRole('group', { name: /God Engine Private Limited/ });
  await expect(god.getByRole('option', { name: /^HRMS/ })).toBeVisible();
});
