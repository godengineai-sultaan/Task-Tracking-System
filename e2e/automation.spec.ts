import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

const RECIPE = 'Urgent work gets a reviewer';

test('manager creates a team rule from a preset, dry-runs it, and sees it fire', async ({ page }) => {
  await signIn(page, 'priya');
  await page.getByRole('link', { name: 'Automations' }).click();
  await expect(page.getByRole('heading', { name: 'Automations', level: 1 })).toBeVisible();
  await expect(page.getByText('You can create rules for the people on your team.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Portal tasks: due-tomorrow reminder' })).toBeVisible();

  // Preset -> builder with plain-language preview
  await page.getByRole('button', { name: `Use recipe: ${RECIPE}` }).click();
  const dialog = page.getByRole('dialog', { name: 'New automation rule' });
  await expect(dialog.getByLabel('Rule name')).toHaveValue(RECIPE);
  await dialog.getByLabel('Project').selectOption({ label: 'WEB · Globex portal v2' });
  await expect(dialog.getByText('When an urgent task in WEB is created, make the owner\'s manager the reviewer and add "Second pair of eyes before closing" to the checklist. Only for tasks owned by Priya Nair\'s team.')).toBeVisible();

  // Dry run against a real task: explains why it would not run, changes nothing
  await dialog.getByRole('button', { name: /Test against a task/ }).click();
  await dialog.getByLabel('Find a task').fill('Order status API');
  await dialog.getByRole('button', { name: /Order status API endpoint/ }).click();
  await expect(dialog.getByText('Would not run')).toBeVisible();
  await expect(dialog.getByRole('listitem').filter({ hasText: /Priority:.*rule needs urgent/ })).toBeVisible();
  await expect(dialog.getByText('Dry run: nothing was changed and nobody was notified.')).toBeVisible();

  await dialog.getByRole('button', { name: 'Create rule' }).click();
  await expect(page.getByText(`Rule "${RECIPE}" created and running`)).toBeVisible();
  await expect(page.getByRole('switch', { name: `${RECIPE}: on` })).toBeVisible();

  // Fire it: an urgent WEB task for someone on Priya's team
  const result = await page.evaluate(async () => {
    const h = { 'x-requested-with': 'fetch', 'content-type': 'application/json' };
    const users = await (await fetch('/api/users')).json();
    const projects = await (await fetch('/api/projects')).json();
    const rahul = users.find((u: any) => u.email === 'rahul@northwind.example');
    const web = projects.find((p: any) => p.key === 'WEB');
    const t = await (await fetch('/api/tasks', { method: 'POST', headers: h, body: JSON.stringify({ title: 'E2E urgent hotfix', ownerId: rahul.id, priority: 'urgent', projectId: web.id }) })).json();
    const d = await (await fetch(`/api/tasks/${t.id}`)).json();
    return { reviewer: d.reviewer?.name, requiresReview: d.task.requires_review, checklist: d.checklist.map((c: any) => c.text) };
  });
  expect(result).toEqual({ reviewer: 'Priya Nair', requiresReview: true, checklist: ['Second pair of eyes before closing'] });

  // Run log shows the run; the task opens in the drawer
  await page.getByRole('radio', { name: 'Run log' }).click();
  const run = page.getByRole('listitem').filter({ hasText: 'E2E urgent hotfix' });
  await expect(run.getByText('Ran', { exact: true })).toBeVisible();
  await expect(run.getByText(/Priya Nair is now the reviewer; Added a checklist item/)).toBeVisible();
  await run.getByRole('button', { name: /E2E urgent hotfix/ }).click();
  await expect(page.getByText('Second pair of eyes before closing')).toBeVisible();
  await page.keyboard.press('Escape');

  // Pause it
  await page.getByRole('radio', { name: 'Rules' }).click();
  await page.getByRole('switch', { name: `${RECIPE}: on` }).click();
  await expect(page.getByText(`"${RECIPE}" is paused`)).toBeVisible();
  await expect(page.getByRole('switch', { name: `${RECIPE}: off` })).toBeVisible();
});

test('employees can view rules but not change them', async ({ page }) => {
  await signIn(page, 'rahul');
  await page.goto('/automations');
  await expect(page.getByText('You can view rules; system admins and team managers can change them.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New rule' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Use recipe/ })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Escalate blocked finance tasks: on' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
});

test('automations page: accessible and fits a phone screen', async ({ browser, page }) => {
  await signIn(page, 'asha');
  await page.goto('/automations');
  await expect(page.getByRole('switch', { name: 'Escalate blocked finance tasks: on' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const scan = async () => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations
    .filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${v.id}: ${v.nodes.length} nodes — ${v.help}`);
  expect(await scan()).toEqual([]);
  await page.getByRole('button', { name: 'New rule' }).click();
  await expect(page.getByRole('dialog', { name: 'New automation rule' })).toBeVisible();
  expect(await scan()).toEqual([]);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await ctx.newPage();
  await signIn(phone, 'priya');
  await phone.goto('/automations');
  await expect(phone.getByRole('heading', { name: 'Portal tasks: due-tomorrow reminder' })).toBeVisible();
  const overflow = () => phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await phone.getByRole('button', { name: `Use recipe: ${RECIPE}` }).click();
  await expect(phone.getByRole('dialog')).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await phone.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await phone.getByRole('radio', { name: 'Run log' }).click();
  await expect(phone.getByRole('heading', { name: 'Run log' })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await ctx.close();
});
