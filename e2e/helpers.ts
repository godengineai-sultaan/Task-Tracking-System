import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

export const PASSWORD = () => readFileSync('.data/demo-credentials.txt', 'utf8').match(/^Password.*: (.+)$/m)![1];
export async function signIn(page: Page, who: string, domain = 'northwind.example') {
  await page.goto('/login');
  await page.getByLabel('Organization').fill('demo');
  await page.getByLabel('Work email').fill(`${who}@${domain}`);
  await page.getByLabel('Password').fill(PASSWORD());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
