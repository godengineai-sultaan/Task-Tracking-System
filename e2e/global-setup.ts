import { execSync } from 'node:child_process';
export default async function () {
  execSync('npx tsx server/src/cli/seed.ts', { stdio: 'inherit' });
}
