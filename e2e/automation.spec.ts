import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

const RECIPE = 'Urgent work gets a reviewer';
const scan = async (page: Page) => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations
  .filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${v.id}: ${v.nodes.length} nodes — ${v.help}`);

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
  expect(await scan(page)).toEqual([]);
  await page.getByRole('button', { name: 'New rule' }).click();
  await expect(page.getByRole('dialog', { name: 'New automation rule' })).toBeVisible();
  expect(await scan(page)).toEqual([]);

  for (const colorScheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme });
    const phone = await ctx.newPage();
    await signIn(phone, 'priya');
    await phone.goto('/automations');
    await expect(phone.getByRole('heading', { name: 'Portal tasks: due-tomorrow reminder' })).toBeVisible();
    const overflow = () => phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    expect(await scan(phone), `${colorScheme} phone rules`).toEqual([]);
    await phone.getByRole('button', { name: `Use recipe: ${RECIPE}` }).click();
    await expect(phone.getByRole('dialog')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await phone.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await phone.getByRole('radio', { name: 'Run log' }).click();
    await expect(phone.getByRole('heading', { name: 'Run log' })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await ctx.close();
  }
});

test('every automations view passes axe (WCAG 2 A/AA) in light and dark', async ({ page }) => {
  await signIn(page, 'asha');
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto('/automations');
    await expect(page.getByRole('switch', { name: 'Escalate blocked finance tasks: on' })).toBeVisible();
    expect(await scan(page), `${colorScheme}: rules`).toEqual([]);

    // Builder from a recipe, with the dry-run panel open and a task picked
    await page.getByRole('button', { name: 'Use recipe: Escalate blocked finance tasks' }).click();
    const builder = page.getByRole('dialog', { name: 'New automation rule' });
    await builder.getByRole('button', { name: /Test against a task/ }).click();
    await builder.getByLabel('Find a task').fill('Bank reconciliation');
    await builder.getByRole('button', { name: /Bank reconciliation/ }).first().click();
    await expect(builder.getByText('Would run')).toBeVisible();
    expect(await scan(page), `${colorScheme}: builder with dry run`).toEqual([]);
    await page.keyboard.press('Escape'); // untouched recipe: closes straight away
    await expect(builder).toHaveCount(0);

    // "Test against a task" dialog from the rule list
    await page.getByRole('button', { name: 'Test Escalate blocked finance tasks against a task' }).click();
    const tester = page.getByRole('dialog', { name: 'Test "Escalate blocked finance tasks"' });
    await tester.getByLabel('Find a task').fill('Bank reconciliation');
    await tester.getByRole('button', { name: /Bank reconciliation/ }).first().click();
    await expect(tester.getByText('Dry run: nothing was changed and nobody was notified.')).toBeVisible();
    expect(await scan(page), `${colorScheme}: test dialog`).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(tester).toHaveCount(0);

    // Archive asks first; Escape keeps the rule
    await page.getByRole('button', { name: 'Archive Escalate blocked finance tasks' }).click();
    await expect(page.getByRole('dialog', { name: 'Archive this rule?' })).toBeVisible();
    expect(await scan(page), `${colorScheme}: archive confirm`).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('switch', { name: 'Escalate blocked finance tasks: on' })).toBeVisible();

    // Run log, and a filter with no matches explains itself and offers a way back
    await page.getByRole('radio', { name: 'Run log' }).click();
    await expect(page.getByRole('button', { name: /Bank reconciliation/ })).toBeVisible();
    expect(await scan(page), `${colorScheme}: run log`).toEqual([]);
    await page.getByLabel('Rule', { exact: true }).selectOption({ label: 'Follow up when changes are requested' });
    await expect(page.getByText('No runs for this rule yet')).toBeVisible();
    expect(await scan(page), `${colorScheme}: run log, no matches`).toEqual([]);
    await page.getByRole('button', { name: 'Show all runs' }).click();
    await expect(page.getByRole('button', { name: /Bank reconciliation/ })).toBeVisible();
  }
});

test('the rule builder works by keyboard and never drops a draft by accident', async ({ page }) => {
  await signIn(page, 'asha');
  await page.goto('/automations');
  await page.getByRole('button', { name: 'New rule' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New automation rule' });
  await expect(dialog.getByLabel('Rule name')).toBeFocused();
  await page.keyboard.type('Draft rule');
  await page.keyboard.press('Escape');
  await expect(dialog.getByText('Discard your changes?')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByLabel('Rule name')).toBeFocused();
  await expect(dialog.getByLabel('Rule name')).toHaveValue('Draft rule');
  for (let i = 0; i < 45; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true);
  }
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New rule' })).toBeFocused();
});

test('client accounts are sent to their portal instead of automations', async ({ page }) => {
  await signIn(page, 'lena', 'globex.example');
  await page.goto('/automations');
  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Your projects' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  expect(await scan(page)).toEqual([]);
});

test('a system admin editing a manager\'s team rule sees that manager\'s team, not their own', async ({ page }) => {
  await signIn(page, 'asha');
  await page.goto('/automations');
  await page.getByRole('button', { name: 'Edit Portal tasks: due-tomorrow reminder' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit automation rule' });
  await expect(dialog.getByText('When a task in WEB is due by tomorrow, notify the owner. Only for tasks owned by Priya Nair\'s team.')).toBeVisible();
});
