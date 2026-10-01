import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

// Regression tests for the web audit fixes (navigation, access guards, error states, dialogs, labels and focus).
test.use({ serviceWorkers: 'block' }); // so page.route sees every API request

const api = (page: Page, method: string, url: string, body?: unknown) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch(u as string, { method: m as string, headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
}, [method, url, body] as const);
const axeClean = async (page: Page) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${v.id}: ${v.help}`)).toEqual([]);
};
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const fail500 = (page: Page, pattern: string) => page.route(pattern, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal', message: 'Something went wrong' }) }));
/** Selects whose visible width is smaller than their selected option needs (the label is cut off). */
const truncatedSelects = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLSelectElement>('main select')].filter((s) => {
  if (!s.offsetParent) return false;
  const probe = s.cloneNode(false) as HTMLSelectElement;
  Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', width: 'auto', minWidth: '0', maxWidth: 'none', fieldSizing: 'content' });
  const o = document.createElement('option'); o.text = s.options[s.selectedIndex]?.text ?? ''; probe.appendChild(o);
  document.body.appendChild(probe); const need = probe.getBoundingClientRect().width; probe.remove();
  return s.getBoundingClientRect().width + 0.5 < need;
}).map((s) => s.getAttribute('aria-label')));

test('seams-9 / ux-11: Client updates and Profitability links follow project ownership, not the manager flag', async ({ page }) => {
  await signIn(page, 'asha');
  const web = (await api(page, 'GET', '/api/projects')).body.find((p: any) => p.key === 'WEB');
  const priyaId = web.owner_id;
  const people = (await api(page, 'GET', '/api/people')).body;
  const devId = people.find((p: any) => p.name === 'Dev Patel').id;
  // Dev (member, owns the internal OPS project) can open the hours-only Profitability view, so it is in his nav.
  await page.context().clearCookies();
  await signIn(page, 'dev');
  await expect(nav(page).getByRole('link', { name: 'Profitability' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Client updates' })).toHaveCount(0);

  // Hand the client project to Dev: he can now prepare client updates and sees the page; Priya (a manager with no client project) does not.
  await page.context().clearCookies();
  await signIn(page, 'asha');
  expect((await api(page, 'PATCH', `/api/projects/${web.id}`, { ownerId: devId })).status).toBe(200);
  try {
    await page.context().clearCookies();
    await signIn(page, 'dev');
    await expect(nav(page).getByRole('link', { name: 'Client updates' })).toBeVisible();
    await page.context().clearCookies();
    await signIn(page, 'priya');
    await expect(nav(page).getByRole('link', { name: 'Team routine' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Client updates' })).toHaveCount(0);
  } finally {
    await page.context().clearCookies();
    await signIn(page, 'asha');
    expect((await api(page, 'PATCH', `/api/projects/${web.id}`, { ownerId: priyaId })).status).toBe(200);
  }
  await page.context().clearCookies();
  await signIn(page, 'priya');
  await expect(nav(page).getByRole('link', { name: 'Client updates' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Profitability' })).toBeVisible();
});

test('ux-2: client accounts are sent to the portal from every staff page', async ({ page }) => {
  await signIn(page, 'lena', 'globex.example');
  for (const path of ['/tasks', '/projects', '/recurring', '/admin/routine', '/analytics', '/admin', '/capacity', '/insights', '/recap', '/templates']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/portal$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Your projects' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New task' })).toHaveCount(0);
  }
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings$/);
});

test('ux-3 / ux-6: people who cannot change a task get a plain status and no Reassign; the task drawer is named', async ({ page }) => {
  const title = 'Order laptop and accessories'; // Dev Patel's planned task on the company-visible OPS project
  await signIn(page, 'rahul');
  await page.goto(`/tasks?q=${encodeURIComponent('Order laptop')}`);
  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: /^Status:/ })).toHaveCount(0);
  await row.getByRole('button', { name: new RegExp(title) }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(title) });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: /^Status:/ })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Reassign' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The owner still gets the status menu and Reassign.
  await page.context().clearCookies();
  await signIn(page, 'dev');
  await page.goto(`/tasks?q=${encodeURIComponent('Order laptop')}`);
  const own = page.getByRole('row').filter({ hasText: title });
  await expect(own.getByRole('button', { name: /^Status:/ })).toBeVisible();
  await own.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByRole('dialog', { name: new RegExp(title) }).getByRole('button', { name: 'Reassign' })).toBeVisible();
});

test('ux-4: Administration shows no-access or an error, never an endless skeleton', async ({ page }) => {
  await signIn(page, 'rahul');
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible();
  await expect(page.getByText('Not available for your account')).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Section' })).toHaveCount(0);
  await axeClean(page);

  await page.context().clearCookies();
  await signIn(page, 'asha');
  await fail500(page, '**/api/admin/tenant');
  await fail500(page, '**/api/admin/users');
  await fail500(page, '**/api/admin/audit*');
  for (const tab of ['org', 'people', 'audit']) {
    await page.goto(`/admin?tab=${tab}`);
    await expect(page.getByText("Couldn't load this"), tab).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  }
});

test('ux-5: the notifications popover is a named dialog that takes focus and closes on Escape', async ({ page }) => {
  await signIn(page, 'asha');
  const bell = page.getByRole('button', { name: /^Notifications/ });
  await bell.click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  await expect(panel).toBeVisible();
  await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(bell).toBeFocused();
  // Nothing invisible is left blocking the page.
  await page.getByRole('button', { name: /^Theme:/ }).click({ timeout: 3000 });
});

test('ux-7: Daily routine explains it is unavailable instead of pretending to be a team manager', async ({ page }) => {
  for (const who of ['rahul', 'vikram']) {
    await page.context().clearCookies();
    await signIn(page, who);
    await page.goto('/admin/routine');
    await expect(page.getByRole('heading', { level: 1, name: 'Daily routine' })).toBeVisible();
    await expect(page.getByText('Not available for your account')).toBeVisible();
    await expect(page.getByText(/Team manager · your teams/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'PDF' })).toHaveCount(0);
    await expect(page.getByLabel('Department')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  }
});

test('ux-8: no-access keeps the page title and never offers Retry; server failures keep the title and offer Retry', async ({ page }) => {
  await signIn(page, 'rahul');
  for (const [path, title] of [['/leadership', 'Leadership delivery'], ['/insights', 'Insights'], ['/capacity', 'Team capacity'], ['/portal', 'Your projects']]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: title }), path).toBeVisible();
    await expect(page.getByText('Not available for your account'), path).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' }), path).toHaveCount(0);
  }
  await page.context().clearCookies();
  await signIn(page, 'asha');
  for (const [path, pattern, title] of [['/', '**/api/my-day', 'My Day'], ['/recap', '**/api/recap*', 'Daily recap'], ['/integrations', '**/api/integrations', 'Integrations'], ['/calendar', '**/api/calendar/schedule*', 'Calendar & leave']]) {
    await fail500(page, pattern);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: title }), path).toBeVisible();
    await expect(page.getByText("Couldn't load this").first(), path).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Retry' }).first(), path).toBeVisible();
    await page.unroute(pattern);
  }
});

test('ux-10: filter selects show their full default labels on desktop and phone', async ({ browser }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await signIn(page, 'asha');
    for (const path of ['/tasks', '/admin/routine']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(await truncatedSelects(page), `${path} at ${viewport.width}`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    }
    await ctx.close();
  }
});

test('ux-12: recurring work is called a recurring task, not a template', async ({ page }) => {
  await signIn(page, 'rahul');
  await page.goto('/recurring');
  await expect(page.getByRole('heading', { level: 1, name: 'Recurring work' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New template' })).toHaveCount(0);
  await expect(page.getByText(/Templates create/)).toHaveCount(0);
  await page.getByRole('button', { name: 'New recurring task' }).click();
  await expect(page.getByRole('dialog', { name: 'New recurring task' })).toBeVisible();
});

test('ux-13: the tenant accent and logo are applied from the session, without waiting for branding', async ({ page }) => {
  await page.route('**/api/branding', (r) => r.abort());
  await signIn(page, 'asha');
  await expect(nav(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#0f766e');
  await expect(nav(page).locator('img').first()).toHaveAttribute('src', /\/api\/branding\/logo/);
});

test('ux-14: the routine view has one label in the nav and the command palette', async ({ page }) => {
  for (const [who, label] of [['asha', 'Daily routine'], ['priya', 'Team routine']]) {
    await page.context().clearCookies();
    await signIn(page, who);
    await expect(nav(page).getByRole('link', { name: label, exact: true })).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.getByPlaceholder('Search or run an action…')).toBeFocused();
    await expect(page.getByRole('option', { name: label, exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Admin daily routine' })).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
});

test('ux-17: on a phone the empty Open work card offers a Capture button instead of the Q shortcut', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.route('**/api/my-day', async (r) => {
    if (r.request().method() !== 'GET') return r.continue();
    const res = await r.fetch(); const body = await res.json();
    await r.fulfill({ response: res, json: { ...body, openTasks: [] } });
  });
  await signIn(page, 'asha');
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Open work' }) });
  await expect(card.getByText('Nothing else open')).toBeVisible();
  await expect(card.getByText('Q', { exact: true })).toBeHidden();
  await card.getByRole('button', { name: 'Capture work' }).click();
  await expect(page.getByLabel('Describe the task in one line')).toBeFocused();
  await ctx.close();
});

test('ux-18: saving and deleting a task view use the app dialogs, and delete asks first', async ({ page }) => {
  page.on('dialog', (d) => { throw new Error(`Unexpected browser dialog: ${d.message()}`); });
  await signIn(page, 'rahul');
  await page.goto('/tasks?priority=urgent');
  await page.getByRole('button', { name: 'Save view' }).click();
  const save = page.getByRole('dialog', { name: 'Save view' });
  await save.getByLabel('View name').fill('Urgent only (audit)');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  const chip = page.getByRole('button', { name: 'Urgent only (audit)', exact: true });
  await expect(chip).toBeVisible();
  await page.getByRole('button', { name: 'Delete view Urgent only (audit)' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete saved view?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(chip).toBeVisible();
  await page.getByRole('button', { name: 'Delete view Urgent only (audit)' }).click();
  await page.getByRole('dialog', { name: 'Delete saved view?' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(chip).toHaveCount(0);
});

test('ux-19: organization modules use readable names and no environment variable names', async ({ page }) => {
  await signIn(page, 'asha');
  await page.goto('/admin');
  for (const label of ['Tasks', 'Analytics', 'Admin routine', 'Integrations', 'Client portal', 'AI drafting']) await expect(page.getByRole('checkbox', { name: label, exact: true })).toBeVisible();
  await expect(page.getByText(/ANTHROPIC_API_KEY/)).toHaveCount(0);
  await expect(page.getByText('Requires AI to be configured by your server operator.', { exact: false })).toBeVisible();
});

test('ux-20: opening a template or a client update moves focus to its heading', async ({ page }) => {
  await signIn(page, 'rahul');
  await page.goto('/templates');
  const card = page.getByRole('link', { name: /Client UAT round/ });
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Client UAT round' })).toBeFocused();

  await page.context().clearCookies();
  await signIn(page, 'lena', 'globex.example');
  await page.goto('/portal');
  const update = page.getByRole('link', { name: /^Update for/ }).first();
  await update.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
});
