import { execSync } from 'node:child_process';

export default async function () {
  // Fresh test database each run (project-local cluster), then migrate.
  execSync('bash scripts/db.sh reset-test', { stdio: 'pipe' });
  const { readFileSync } = await import('node:fs');
  const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  process.env.DATABASE_URL = env.DATABASE_URL.replace(/\/[^/]+$/, `/${env.TEST_DATABASE_NAME}`);
  process.env.MIGRATION_DATABASE_URL = env.MIGRATION_DATABASE_URL.replace(/\/[^/]+$/, `/${env.TEST_DATABASE_NAME}`);
  const { migrate } = await import('../server/src/cli/migrate.js');
  await migrate(process.env.MIGRATION_DATABASE_URL);
}
