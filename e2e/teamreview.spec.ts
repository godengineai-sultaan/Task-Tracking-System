import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers';

async function noSeriousAxe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''));
  expect(bad.map((v) => `${v.id}: ${v.nodes.length} nodes — ${v.help}`)).toEqual([]);
}

test('manager reviews a week and the employee sees the note and responds', async ({ page }) => {
  const note = 'Strong week on the order sync work. Let us split the load test before Friday.';
  const response = 'Thanks. I will split the load test into two smaller tasks.';
  await signIn(page, 'priya');
  await page.getByRole('link', { name: 'Weekly team review' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Weekly team review' })).toBeVisible();
  await expect(page.getByText('Team manager · your teams')).toBeVisible();
  // Only Priya's team, alphabetical (never ranked).
  const names = page.getByRole('article').locator('h2');
  await expect(names).toHaveText(['Rahul Verma', 'Sara Khan']);
  await expect(page.getByRole('article', { name: 'Sara Khan' }).getByText('Your review')).toBeVisible(); // seeded "discussed" review with a response
  await noSeriousAxe(page);

  const rahul = page.getByRole('article', { name: 'Rahul Verma' });
  await expect(rahul.getByText('You have not reviewed this week yet.')).toBeVisible();
  await rahul.getByRole('button', { name: "Acknowledge Rahul Verma's week" }).click();
  const dialog = page.getByRole('dialog', { name: "Review Rahul Verma's week" });
  await expect(dialog.getByLabel('Note for Rahul')).toBeFocused();
  await dialog.getByLabel('Note for Rahul').fill(note);
  await noSeriousAxe(page);
  await dialog.getByRole('button', { name: 'Save review' }).click();
  await expect(page.getByText('Review saved as acknowledged. Rahul has been notified.')).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(rahul.getByText(note)).toBeVisible();
  await expect(rahul.getByText('Acknowledged', { exact: true })).toHaveCount(2); // header badge + review note badge

  // The employee opens the notification and sees the reviewer's note.
  await page.context().clearCookies();
  await signIn(page, 'rahul');
  await page.getByRole('button', { name: /^Notifications/ }).first().click();
  await page.getByRole('button', { name: /Priya Nair acknowledged your week/ }).first().click();
  await expect(page).toHaveURL(/\/team-review\?tab=mine&week=/);
  await expect(page.getByRole('heading', { level: 1, name: 'My weekly reviews' })).toBeVisible();
  const card = page.getByRole('article').filter({ hasText: note });
  await expect(card).toContainText('Reviewed by Priya Nair');
  await expect(page.getByRole('link', { name: 'Weekly team review' })).toHaveCount(0);
  await card.getByLabel('Your response').fill(response);
  await card.getByRole('button', { name: 'Send response' }).click();
  await expect(page.getByText('Response sent to Priya')).toBeVisible();
  await expect(card.getByText(response)).toBeVisible();
  await noSeriousAxe(page);
  // Employees cannot open the team view through the API either.
  expect(await page.evaluate(() => fetch('/api/team-review').then((r) => r.status))).toBe(403);

  // The manager sees the response on the card.
  await page.context().clearCookies();
  await signIn(page, 'priya');
  await page.goto('/team-review');
  await expect(page.getByRole('article', { name: 'Rahul Verma' }).getByText(response)).toBeVisible();
});

test('main admin: company-wide week, filters, table view, export and phone layout', async ({ page }) => {
  await signIn(page, 'asha');
  await page.goto('/team-review');
  await expect(page.getByText('Main administrator · company-wide')).toBeVisible();
  const names = page.getByRole('article').locator('h2');
  await expect(names).toHaveCount(7);
  const list = await names.allInnerTexts();
  expect(list).toEqual([...list].sort((a, b) => a.localeCompare(b)));
  expect(list).not.toContain('Asha Rao');
  await expect(page.getByRole('article', { name: 'Meera Iyer' }).getByRole('link', { name: /Follow-up: Agree vendor invoice cut-off/ })).toBeVisible();
  // While that follow-up task is open, the dialog does not offer a second one (it would orphan the first).
  await page.getByRole('button', { name: 'Request follow-up for Meera Iyer' }).click();
  const dlg = page.getByRole('dialog', { name: "Review Meera Iyer's week" });
  await expect(dlg.getByText(/Follow-up task already open: Agree vendor invoice cut-off/)).toBeVisible();
  await expect(dlg.getByText(/Also create a follow-up task/)).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(dlg).toBeHidden();

  await page.getByRole('button', { name: /^Not reviewed yet/ }).click();
  await expect(page.getByRole('button', { name: /^Not reviewed yet/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(names).toHaveCount(5);
  await page.getByRole('radio', { name: /Table/ }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(5);
  await noSeriousAxe(page);

  // Drill link to the individual week report.
  await page.getByRole('link', { name: /Rahul Verma/ }).first().click();
  await expect(page).toHaveURL(/\/analytics\/[0-9a-f-]+\?kind=week&date=\d{4}-\d{2}-\d{2}/);
  await expect(page.getByRole('heading', { level: 1, name: 'Rahul Verma' })).toBeVisible();
  await page.goBack();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^team-week-\d{4}-\d{2}-\d{2}\.csv$/);

  // A malformed ?week= falls back to last week instead of crashing the page.
  await page.goto('/team-review?week=not-a-date');
  await expect(page.getByRole('heading', { level: 1, name: 'Weekly team review' })).toBeVisible();
  await expect(names).toHaveCount(7);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/team-review');
  await expect(names.first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.goto('/team-review?view=table');
  await expect(page.getByRole('table')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
