import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

const noSeriousAxe = async (page: any) => {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(bad.map((v) => `${v.id}: ${v.nodes.length} nodes - ${v.help}`)).toEqual([]);
};

test('manager applies a starter template to a project and sees the created tasks', async ({ page }) => {
  await signIn(page, 'priya');
  await page.getByRole('link', { name: 'Templates' }).click();
  await expect(page.getByRole('heading', { name: 'Templates', level: 1 })).toBeVisible();
  const gallery = page.getByRole('list', { name: 'Templates' });
  await expect(gallery.getByRole('link', { name: /New employee onboarding/ })).toBeVisible();

  await page.getByLabel('Search templates').fill('kickoff');
  await expect(gallery.getByRole('listitem')).toHaveCount(1);
  await gallery.getByRole('link', { name: /Client project kickoff/ }).click();
  await expect(page.getByRole('heading', { name: 'Client project kickoff', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Run the kickoff meeting/ })).toBeVisible();

  await page.getByRole('button', { name: 'Apply template' }).click();
  const dialog = page.getByRole('dialog', { name: 'Apply "Client project kickoff"' });
  await dialog.getByLabel('Start date').fill('2030-03-04'); // a Monday
  await dialog.getByLabel('Project (optional)').selectOption({ label: 'WEB · Globex portal v2' });
  await dialog.getByLabel('Default owner').selectOption({ label: 'Rahul Verma' });
  await dialog.getByRole('button', { name: 'Next: owners and dates' }).click();

  // Preview: working-day due dates computed on the server, one owner per step
  await expect(dialog.getByLabel(/^Owner for step 1:/)).toHaveValue(/.+/);
  await dialog.getByLabel(/^Owner for step 1:/).selectOption({ label: 'Priya Nair' });
  const rows = dialog.getByRole('listitem').filter({ has: page.getByRole('combobox') });
  await expect(rows).toHaveCount(7);
  await expect(rows.nth(2)).toContainText(/Mar 7, 2030/); // "Run the kickoff meeting": Day +3 from Monday
  await expect(rows.nth(6)).toContainText(/Mar 13, 2030/); // Day +7 skips the weekend
  await noSeriousAxe(page);

  await dialog.getByRole('button', { name: 'Create 7 tasks' }).click();
  await expect(dialog.getByText('Created 7 tasks from "Client project kickoff".')).toBeVisible();
  const created = dialog.getByRole('list', { name: 'Created tasks' }).getByRole('link');
  await expect(created).toHaveCount(7);
  await expect(created.first()).toContainText('Internal handover from sales');

  // The tasks are real: they show up in the project with their owners
  await dialog.getByRole('link', { name: 'WEB · Globex portal v2' }).click();
  await expect(page.getByRole('heading', { name: 'Globex portal v2', level: 1 })).toBeVisible();
  await expect(page.getByText('Run the kickoff meeting').first()).toBeVisible();
  await expect(page.getByText('Build the milestone plan').first()).toBeVisible();

  // and the template remembers the use
  await page.goto('/templates');
  await page.getByLabel('Search templates').fill('kickoff');
  await expect(page.getByRole('list', { name: 'Templates' }).getByRole('link', { name: /Client project kickoff/ })).toContainText('Used 1 time');
});

test('employee builds a private template with a dependency and applies it to themself', async ({ page }) => {
  await signIn(page, 'kabir');
  await page.goto('/templates');
  await page.getByRole('button', { name: 'New template' }).first().click();
  await expect(page.getByRole('heading', { name: 'New template', level: 1 })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Renewal call prep (e2e)');
  await expect(page.getByLabel('Who can use it')).toHaveValue('private');
  await page.getByLabel('Step 1 title').fill('Review account history');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByLabel('Step 2 title').fill('Send renewal proposal');
  await page.getByLabel('Due (work day)').nth(1).fill('2');
  await page.getByRole('checkbox', { name: '1. Review account history' }).check();
  // keyboard-accessible reorder keeps the dependency attached to the right step
  await page.getByRole('button', { name: 'Move Send renewal proposal up' }).click();
  await page.getByRole('button', { name: 'Move Send renewal proposal down' }).click();
  await page.getByRole('button', { name: 'Create template' }).click();

  await expect(page.getByRole('heading', { name: 'Renewal call prep (e2e)', level: 1 })).toBeVisible();
  await expect(page.getByText('After step 1')).toBeVisible();
  await expect(page.getByText('Only you (private)')).toBeVisible();
  await noSeriousAxe(page);

  await page.getByRole('button', { name: 'Apply template' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Default owner')).toHaveValue(/.+/);
  await dialog.getByRole('button', { name: 'Next: owners and dates' }).click();
  await dialog.getByRole('button', { name: 'Create 2 tasks' }).click();
  await expect(dialog.getByText(/Created 2 tasks/)).toBeVisible();
  await dialog.getByRole('link', { name: /Send renewal proposal/ }).click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}/);
  await expect(page.getByText('Review account history').first()).toBeVisible(); // shown as a dependency
});

test('templates gallery and detail work at phone width and pass axe', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signIn(page, 'sara');
  await page.goto('/templates');
  await expect(page.getByRole('list', { name: 'Templates' }).getByRole('listitem').first()).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await noSeriousAxe(page);
  await page.getByRole('list', { name: 'Templates' }).getByRole('link', { name: /Month-end close/ }).click();
  await expect(page.getByRole('heading', { name: 'Month-end close', level: 1 })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  // employees can use but not edit company templates
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Duplicate' })).toBeVisible();
  await ctx.close();
});

const focusInDialog = (page: any) => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'));

test('apply wizard keeps keyboard focus in the dialog and every step passes axe in dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await signIn(page, 'asha');
  await page.goto('/templates');
  await page.getByRole('list', { name: 'Templates' }).getByRole('link', { name: /Weekly team review/ }).click();
  await expect(page.getByRole('heading', { name: 'Weekly team review', level: 1 })).toBeVisible();
  await noSeriousAxe(page);

  const applyBtn = page.getByRole('button', { name: 'Apply template' });
  await applyBtn.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Apply "Weekly team review"' });
  await expect(dialog.getByLabel('Start date')).toBeFocused();
  await noSeriousAxe(page);
  await dialog.getByLabel('Start date').fill('2030-03-04');

  // keyboard: Next replaces the footer buttons, focus moves to the step heading inside the dialog
  await dialog.getByRole('button', { name: 'Next: owners and dates' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('heading', { name: 'Step 2 of 3: Owners and dates' })).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await focusInDialog(page)).toBe(true);
  await expect(dialog.getByLabel(/^Owner for step 1:/)).toBeVisible();
  await noSeriousAxe(page);

  await dialog.getByRole('button', { name: 'Create 5 tasks' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('heading', { name: 'Step 3 of 3: Created' })).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await focusInDialog(page)).toBe(true);
  await expect(dialog.getByRole('list', { name: 'Created tasks' }).getByRole('link')).toHaveCount(5);
  await noSeriousAxe(page);

  // Escape closes the dialog and returns focus to the button that opened it
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(applyBtn).toBeFocused();

  // the use is listed, and its tasks open in a dialog
  await page.getByRole('button', { name: /^View tasks created on/ }).first().click();
  const used = page.getByRole('dialog', { name: 'Tasks created from this template' });
  await expect(used.getByRole('link')).toHaveCount(5);
  await noSeriousAxe(page);
  await page.keyboard.press('Escape');
  await expect(used).toBeHidden();

  // version history of a seeded template with two versions
  await page.goto('/templates');
  await page.getByRole('list', { name: 'Templates' }).getByRole('link', { name: /Client UAT round/ }).click();
  await page.getByRole('button', { name: 'View version 1' }).click();
  const v1 = page.getByRole('dialog', { name: 'Version 1' });
  await expect(v1.getByRole('listitem').first()).toBeVisible();
  await noSeriousAxe(page);
  await page.keyboard.press('Escape');
  await expect(v1).toBeHidden();

  // empty archive view
  await page.goto('/templates');
  await page.getByRole('radio', { name: 'Archived' }).click();
  await expect(page.getByText('Nothing archived')).toBeVisible();
  await noSeriousAxe(page);
});

test('template editor at phone width in dark mode: focus, validation, unsaved changes and axe', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await signIn(page, 'priya');
  await page.goto('/templates');
  await expect(page.getByRole('list', { name: 'Templates' }).getByRole('listitem').first()).toBeVisible();
  await noSeriousAxe(page);

  // save-from-project dialog
  await page.getByRole('button', { name: 'Save from project' }).click();
  const fromProject = page.getByRole('dialog', { name: 'Save a project as a template' });
  await expect(fromProject.getByLabel('Project')).toBeFocused();
  await noSeriousAxe(page);
  await page.keyboard.press('Escape');
  await expect(fromProject).toBeHidden();

  await page.getByRole('button', { name: 'New template' }).first().click();
  await expect(page.getByRole('heading', { name: 'New template', level: 1 })).toBeVisible();
  await noSeriousAxe(page);
  // saving an empty form moves focus to the first problem
  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
  await expect(page.getByText('Fix the highlighted fields before saving.')).toBeVisible();
  await noSeriousAxe(page);

  await page.getByLabel('Name', { exact: true }).fill('Phone-width playbook (e2e)');
  await page.getByLabel('Step 1 title').fill('First step');
  await page.getByRole('button', { name: 'Add step' }).click();
  await expect(page.getByLabel('Step 2 title')).toBeFocused();
  await page.getByLabel('Step 2 title').fill('Second step');
  // moving to the top hands focus to the other move button; removing keeps focus on the neighbouring step
  await page.getByRole('button', { name: 'Move Second step up' }).click();
  await expect(page.getByRole('button', { name: 'Move Second step down' })).toBeFocused();
  await page.getByRole('button', { name: 'Remove Second step' }).click();
  await expect(page.getByLabel('Step 1 title')).toHaveValue('First step');
  await expect(page.getByLabel('Step 1 title')).toBeFocused();
  expect(await overflow()).toBeLessThanOrEqual(0);

  // leaving with unsaved changes asks first
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => asked).toContain('Discard your unsaved changes');
  await expect(page.getByRole('heading', { name: 'New template', level: 1 })).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Templates', level: 1 })).toBeVisible();

  // editing a company template as a manager
  await page.getByRole('list', { name: 'Templates' }).getByRole('link', { name: /Product release checklist/ }).click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByText('Editing version 1')).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await noSeriousAxe(page);
  await ctx.close();
});

test('clients are sent to their portal, without staff actions', async ({ page }) => {
  await signIn(page, 'lena', 'globex.example');
  await page.goto('/templates');
  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Your projects' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New template' })).toHaveCount(0);
  await noSeriousAxe(page);
});
