import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

const axe = async (page: Page) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')).map((v) => `${v.id}: ${v.nodes.length} nodes — ${v.help} ${JSON.stringify(v.nodes.map((n) => [n.target, n.failureSummary]))}`)).toEqual([]);
};
const api = (page: Page, method: string, url: string, body?: unknown) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch(u as string, { method: m as string, headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, type: r.headers.get('content-type'), body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
}, [method, url, body] as const);
const accentVar = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
const noHorizontalScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

test('branding: an inaccessible accent is blocked and the nearest accessible shade is applied at runtime', async ({ page }) => {
  await signIn(page, 'asha');
  await page.goto('/admin?tab=branding');
  await expect(page.getByRole('heading', { name: 'Brand identity' })).toBeVisible();
  await expect.poll(() => accentVar(page)).toBe('#0f766e'); // seeded demo accent
  await axe(page);

  const hex = page.getByLabel('Accent colour (hex)');
  // No error while a value is still being typed; it appears once the field is left.
  await hex.fill('#7f');
  await expect(page.getByText('Use a 6-digit hex colour such as #256abf.')).toHaveCount(0);
  await hex.blur();
  await expect(page.getByText('Use a 6-digit hex colour such as #256abf.')).toBeVisible();
  await hex.fill('#7fb2ff');
  await expect(page.getByText(/can't be saved/)).toBeVisible();
  // The preview shows the suggested shade rather than going blank.
  await expect(page.getByText(/Showing the suggested shade #[0-9a-f]{6}, because #7fb2ff can't be used/)).toBeVisible();
  await axe(page);
  await expect(page.getByRole('button', { name: 'Save branding' })).toBeDisabled();
  const useBtn = page.getByRole('button', { name: /^Use #[0-9a-f]{6}$/ });
  const suggestion = (await useBtn.textContent())!.replace('Use ', '');
  await useBtn.click();
  await expect(page.getByText(/meets the 4.5:1 minimum/)).toBeVisible();
  await page.getByRole('button', { name: 'Save branding' }).click();
  await expect(page.getByText('Branding saved')).toBeVisible();
  await expect.poll(() => accentVar(page)).toBe(suggestion);

  // The server enforces the same rule even if the UI is bypassed.
  const b = await api(page, 'GET', '/api/branding');
  const bad = await api(page, 'PUT', '/api/branding', { displayName: b.body.displayName, accent: '#ffcc00', version: b.body.version });
  expect(bad.status).toBe(400);
  expect(bad.body.details.suggestion).toMatch(/^#[0-9a-f]{6}$/);

  // Restore the demo accent for later specs.
  await hex.fill('#0f766e');
  await page.getByRole('button', { name: 'Save branding' }).click();
  await expect.poll(() => accentVar(page)).toBe('#0f766e');
  await expect(page.getByRole('img', { name: 'Current logo' })).toBeVisible();

  // Removing the logo is confirmed in a dialog that traps focus and closes on Escape (nothing is removed).
  const remove = page.getByRole('button', { name: 'Remove', exact: true });
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'Remove the logo?' });
  await expect(dialog).toBeVisible();
  await axe(page);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();
  await expect(page.getByRole('img', { name: 'Current logo' })).toBeVisible();

  // Dark mode and phone width (reload so colour transitions from the theme switch have settled).
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Brand identity' })).toBeVisible();
  await expect.poll(() => accentVar(page)).toMatch(/^#[0-9a-f]{6}$/);
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalScroll(page);
  await axe(page);
});

test('client update: the project owner publishes and the client reads it in the portal', async ({ page }) => {
  const summary = `Weekly e2e summary ${Date.now()}: order history export shipped, accessibility review starts next week.`;
  await signIn(page, 'priya');
  await page.goto('/client-updates');
  await expect(page.getByRole('heading', { name: 'Client updates', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /Globex portal v2/ })).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: "Prepare this week's draft" }).click();
  await expect(page.getByText('Draft · not visible to the client')).toBeVisible();
  const updateId = new URL(page.url()).searchParams.get('update')!;
  // Internal (not shared) work never appears in the draft.
  await expect(page.getByText('Customer advisory call: Globex')).toHaveCount(0);
  await expect(page.getByText('Order history export (CSV)')).toBeVisible();

  await page.getByLabel('Summary', { exact: true }).fill(summary);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();
  await page.getByRole('radio', { name: /Preview as client/ }).click();
  await expect(page.getByText(/Exactly what Globex Retail \(fictional client\) will see/)).toBeVisible();
  await expect(page.getByText(summary)).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Publish to client' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish this update?' });
  await expect(dialog.getByText(/Nothing is emailed/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published · visible in the client portal')).toBeVisible();

  // A second, unpublished draft must stay invisible to the client.
  const pending = await api(page, 'POST', '/api/client-updates', { projectId: (await api(page, 'GET', `/api/client-updates/${updateId}`)).body.projectId, periodStart: '2026-01-05', periodEnd: '2026-01-11' });
  expect(pending.body.status).toBe('draft');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText('Published · visible in the client portal')).toBeVisible();
  await noHorizontalScroll(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.context().clearCookies();
  await signIn(page, 'lena', 'globex.example');
  await page.goto('/portal');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  const row = page.getByRole('link', { name: /Update for .*Latest/ });
  await expect(row).toContainText(summary.slice(0, 30));
  await axe(page);
  await row.click();
  await expect(page.getByRole('heading', { level: 1, name: /Globex portal v2/ })).toBeVisible();
  await expect(page.getByText(summary)).toBeVisible();
  await expect(page.getByText('Order history export (CSV)')).toBeVisible();
  await expect(page.getByText('Customer advisory call: Globex')).toHaveCount(0);
  await axe(page);
  const pdf = await api(page, 'GET', `/api/client-updates/${updateId}/pdf`);
  expect(pdf).toMatchObject({ status: 200, type: 'application/pdf' });
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download PDF' }).click();
  expect((await download).suggestedFilename()).toMatch(/^WEB-update-\d{4}-\d{2}-\d{2}\.pdf$/);
  expect((await api(page, 'GET', `/api/client-updates/${pending.body.id}`)).status).toBe(404);
  expect((await api(page, 'GET', '/api/client-updates')).body.every((u: any) => u.id !== pending.body.id)).toBe(true);
  expect((await api(page, 'POST', `/api/client-updates/${pending.body.id}/publish`, { version: 1 })).status).toBe(404);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText(summary)).toBeVisible();
  await noHorizontalScroll(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(page.getByText(summary)).toBeVisible();
  await axe(page);
  await page.goto('/portal');
  await expect(row).toBeVisible();
  await noHorizontalScroll(page);
  await axe(page);
  // A draft (or withdrawn) update shows a clear "not available" state, never its content.
  await page.goto(`/portal?update=${pending.body.id}`);
  await expect(page.getByText("This update isn't available")).toBeVisible();
  await axe(page);
});

test('client update: keyboard flow, dialogs, dark mode and phone layout for the editor', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await signIn(page, 'priya');
  await page.goto('/client-updates');
  await expect(page.getByRole('button', { name: /Globex portal v2/ })).toBeVisible();
  const project = (await api(page, 'GET', '/api/client-updates/projects')).body.find((p: any) => p.name === 'Globex portal v2');
  const draft = await api(page, 'POST', '/api/client-updates', { projectId: project.id, periodStart: '2026-02-02', periodEnd: '2026-02-08' });
  expect(draft.body.status).toBe('draft');
  await page.reload();
  await axe(page);

  // Opening an update with the keyboard moves focus to its heading.
  const row = page.getByRole('button', { name: /Feb 2 – Feb 8, 2026/ });
  await row.focus();
  await page.keyboard.press('Enter');
  const heading = page.getByRole('heading', { name: 'Update for Feb 2 – Feb 8, 2026' });
  await expect(heading).toBeFocused();
  await axe(page);

  // Leaving an item out keeps (and saves) unsaved summary edits.
  const text = page.getByLabel('Summary', { exact: true });
  await text.fill('Keyboard and dark mode check');
  const leaveOut = page.getByRole('button', { name: /^Leave out/ });
  const before = await leaveOut.count();
  if (before > 0) {
    await leaveOut.first().click();
    await expect(leaveOut).toHaveCount(before - 1);
    await expect(text).toHaveValue('Keyboard and dark mode check');
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    if (before > 1) await expect(page.locator('[data-remove]:focus')).toHaveCount(1);
  }

  // Publish with unsaved edits: the dialog says they are saved first; Escape closes it and returns focus.
  await text.fill('Keyboard and dark mode check, edited');
  const publishBtn = page.getByRole('button', { name: 'Publish to client' });
  await publishBtn.click();
  const dialog = page.getByRole('dialog', { name: 'Publish this update?' });
  await expect(dialog.getByText('Your unsaved summary changes are saved first.')).toBeVisible();
  await axe(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(publishBtn).toBeFocused();
  await publishBtn.click();
  await dialog.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published · visible in the client portal')).toBeVisible();
  await expect(heading).toBeFocused();
  expect((await api(page, 'GET', `/api/client-updates/${draft.body.id}`)).body.summary).toBe('Keyboard and dark mode check, edited');

  // Unpublishing needs a reason.
  await page.getByRole('button', { name: 'Unpublish' }).click();
  const un = page.getByRole('dialog', { name: 'Unpublish this update?' });
  await expect(un.getByLabel('Reason')).toBeFocused();
  await expect(un.getByRole('button', { name: 'Unpublish' })).toBeDisabled();
  await axe(page);
  await un.getByLabel('Reason').fill('Wrong week');
  await un.getByRole('button', { name: 'Unpublish' }).click();
  await expect(page.getByText('Draft · not visible to the client')).toBeVisible();
  await expect(heading).toBeFocused();

  // Phone width: preview, then a confirmed discard returns focus to the project's update list.
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalScroll(page);
  await axe(page);
  await page.getByRole('radio', { name: /Preview as client/ }).click();
  await expect(page.getByText('Keyboard and dark mode check, edited')).toBeVisible();
  await noHorizontalScroll(page);
  await axe(page);
  await page.getByRole('button', { name: 'Discard draft' }).click();
  const discard = page.getByRole('dialog', { name: 'Discard this draft?' });
  await axe(page);
  await discard.getByRole('button', { name: 'Discard draft' }).click();
  await expect(page.getByRole('heading', { name: /^Globex portal v2 · / })).toBeFocused();
  await expect(row).toHaveCount(0);
  await noHorizontalScroll(page);
  await axe(page);
});

test('client updates: an employee without client projects sees a clear empty state', async ({ page }) => {
  await signIn(page, 'rahul');
  await expect(page.getByRole('link', { name: 'Client updates' })).toHaveCount(0);
  await page.goto('/client-updates');
  await expect(page.getByText('No client projects you can update')).toBeVisible();
  await axe(page);
});
