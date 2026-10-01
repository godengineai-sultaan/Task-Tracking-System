import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { sha256 } from './crypto.js';
import type { Db } from './db.js';
import { one } from './db.js';

/** Private object storage on local disk, keyed per tenant. Files are only served through authorized routes. */
export async function storeFile(db: Db, tenantId: string, data: Buffer, filename: string, mime: string, purpose: 'evidence' | 'export' | 'import', userId: string | null) {
  const key = `${tenantId}/${randomUUID()}`;
  await mkdir(join(config.storageDir, tenantId), { recursive: true, mode: 0o700 });
  await writeFile(join(config.storageDir, key), data, { mode: 0o600 });
  return one(db, `insert into stored_files (tenant_id, storage_key, filename, mime, size_bytes, sha256, purpose, uploaded_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [tenantId, key, filename.replace(/[^\w.\- ]/g, '_').slice(0, 150), mime, data.length, sha256(data), purpose, userId]);
}
export async function readStored(file: { storage_key: string; sha256: string }) {
  const data = await readFile(join(config.storageDir, file.storage_key));
  if (sha256(data) !== file.sha256) throw new Error('Stored file failed integrity check');
  return data;
}
/** Remove a stored object from disk (after its row is deleted). A file that is already gone is fine. */
export async function removeStored(storageKey: string) {
  await rm(join(config.storageDir, storageKey), { force: true });
}
