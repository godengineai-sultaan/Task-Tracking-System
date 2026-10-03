import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env loader (no dependency): KEY=VALUE lines, existing process env wins.
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return v;
}

/** Fastify trustProxy from TRUST_PROXY: unset/false = off (direct exposure), otherwise comma-separated proxy IPs/CIDRs or
 *  proxy-addr names (e.g. uniquelocal). Fastify 5.12 deliberately ignores bare hop counts (fails closed), so use addresses. */
function trustProxy(v = process.env.TRUST_PROXY ?? ''): boolean | number | string {
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  return /^\d+$/.test(v) ? Number(v) : v;
}

export const config = {
  databaseUrl: req('DATABASE_URL'),
  migrationDatabaseUrl: req('MIGRATION_DATABASE_URL'),
  encryptionKey: Buffer.from(req('APP_ENCRYPTION_KEY'), 'hex'),
  storageDir: resolve(process.cwd(), process.env.STORAGE_DIR || '.data/storage'),
  port: Number(process.env.PORT || 4300),
  // Containers set HOST=0.0.0.0 (the port is only reachable on the private Docker network); local runs stay on loopback.
  host: process.env.HOST || '127.0.0.1',
  trustProxy: trustProxy(),
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:5173',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 168),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  aiModel: process.env.AI_MODEL || 'claude-opus-5-5',
  production: process.env.NODE_ENV === 'production',
};
if (config.encryptionKey.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 64 hex characters');

/** Production fail-fast: refuse to start with placeholder secrets or a non-HTTPS public URL (loopback hosts excepted for local runs). */
export function productionConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const key = env.APP_ENCRYPTION_KEY ?? '';
  if (/^(.)\1*$/.test(key)) problems.push('APP_ENCRYPTION_KEY is a placeholder (generate one with: openssl rand -hex 32)');
  for (const name of ['DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
    let pw = '';
    try { pw = decodeURIComponent(new URL(env[name] ?? '').password); } catch { /* reported below */ }
    if (pw.length < 12 || /change-?me|password|secret/i.test(pw)) problems.push(`${name} has a missing, placeholder or short (<12 chars) password`);
  }
  if (!env.PUBLIC_URL) problems.push('PUBLIC_URL is required (the address users open, e.g. https://app.example.com)');
  else {
    try {
      const u = new URL(env.PUBLIC_URL);
      if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) problems.push('PUBLIC_URL must use https:// for a public domain');
    } catch { problems.push('PUBLIC_URL is not a valid URL'); }
  }
  return problems;
}
if (config.production) {
  const problems = productionConfigProblems();
  if (problems.length) throw new Error(`Refusing to start in production:\n - ${problems.join('\n - ')}`);
}
