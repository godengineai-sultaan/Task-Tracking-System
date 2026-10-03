import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { getApp } from './helpers.js';
import { productionConfigProblems } from '../server/src/lib/config.js';
import { isSchedulerLeader, releaseLeader } from '../server/src/lib/leader.js';

const good = {
  APP_ENCRYPTION_KEY: '3f'.repeat(32),
  DATABASE_URL: 'postgres://taskapp:9c1d2e3f4a5b6c7d8e9f@db:5432/taskapp',
  MIGRATION_DATABASE_URL: 'postgres://taskapp_owner:1a2b3c4d5e6f7a8b9c0d@db:5432/taskapp',
  PUBLIC_URL: 'https://app.example.com',
};

describe('production configuration fail-fast', () => {
  it('accepts generated secrets and an https public URL', () => {
    expect(productionConfigProblems(good)).toEqual([]);
  });
  it('rejects placeholder keys, placeholder/short passwords, http public URLs and a missing PUBLIC_URL', () => {
    const p = productionConfigProblems({ ...good, APP_ENCRYPTION_KEY: '0'.repeat(64),
      DATABASE_URL: 'postgres://taskapp:change-me-app@db/taskapp', MIGRATION_DATABASE_URL: 'postgres://o:short@db/taskapp', PUBLIC_URL: 'http://app.example.com' });
    expect(p).toHaveLength(4);
    expect(productionConfigProblems({ ...good, PUBLIC_URL: '' })).toEqual([expect.stringContaining('PUBLIC_URL is required')]);
  });
  it('allows plain http only for loopback hosts (local production-mode runs)', () => {
    expect(productionConfigProblems({ ...good, PUBLIC_URL: 'http://127.0.0.1:4441' })).toEqual([]);
  });
});

describe('container probes', () => {
  it('liveness and readiness answer without a session and expose no configuration', async () => {
    const app = await getApp();
    const live = await app.inject({ url: '/api/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ ok: true });
    const ready = await app.inject({ url: '/api/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ok: true });
    expect(ready.headers['cache-control']).toBe('no-store');
  });
});

describe('scheduler leader election', () => {
  it('only one holder of the advisory lock at a time; released on shutdown', async () => {
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    const tryLock = async () => (await other.query('select pg_try_advisory_lock(7415001) ok')).rows[0].ok;
    try {
      expect(await isSchedulerLeader()).toBe(true);
      expect(await isSchedulerLeader()).toBe(true); // stays leader while its connection lives
      expect(await tryLock()).toBe(false); // a second replica cannot take over
      await releaseLeader();
      expect(await tryLock()).toBe(true); // the next replica can
      expect(await isSchedulerLeader()).toBe(false);
    } finally { await other.end(); await releaseLeader(); }
  });
});
