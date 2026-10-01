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

export const config = {
  databaseUrl: req('DATABASE_URL'),
  migrationDatabaseUrl: req('MIGRATION_DATABASE_URL'),
  encryptionKey: Buffer.from(req('APP_ENCRYPTION_KEY'), 'hex'),
  storageDir: resolve(process.cwd(), process.env.STORAGE_DIR || '.data/storage'),
  port: Number(process.env.PORT || 4300),
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:5173',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 168),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  aiModel: process.env.AI_MODEL || 'claude-opus-5-5',
  production: process.env.NODE_ENV === 'production',
};
if (config.encryptionKey.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 64 hex characters');
