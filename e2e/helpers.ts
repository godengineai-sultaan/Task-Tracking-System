import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

/** Demo password for an organization's seeded fixtures (demo: .data/demo-credentials.txt, lord: .data/lord-credentials.txt). */
export const PASSWORD = (org = 'demo') => readFileSync(org === 'demo' ? '.data/demo-credentials.txt' : `.data/${org}-credentials.txt`, 'utf8').match(/^Password.*: (.+)$/m)![1];
export async function signIn(page: Page, who: string, domain = 'northwind.example', org = 'demo') {
  await page.goto('/login');
  await page.getByLabel('Organization').fill(org);
  await page.getByLabel('Work email').fill(`${who}@${domain}`);
  await page.getByLabel('Password').fill(PASSWORD(org));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
