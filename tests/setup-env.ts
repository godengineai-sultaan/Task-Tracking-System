// Point every test at the isolated test database before any server module loads config.
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const testDb = env.TEST_DATABASE_NAME || 'taskapp_test';
process.env.DATABASE_URL = env.DATABASE_URL.replace(/\/[^/]+$/, `/${testDb}`);
process.env.MIGRATION_DATABASE_URL = env.MIGRATION_DATABASE_URL.replace(/\/[^/]+$/, `/${testDb}`);
process.env.STORAGE_DIR = '.data/test-storage';
process.env.LOG_SILENT = '1';
process.env.ANTHROPIC_API_KEY = '';
