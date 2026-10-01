import type { Db } from '../lib/db.js';

/** In-app notification. External delivery (email/chat) is a configured dependency and is not sent from here. */
export async function notify(db: Db, tenantId: string, userId: string, kind: string, title: string, body = '', link: string | null = null) {
  await db.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,$3,$4,$5,$6)`,
    [tenantId, userId, kind, title.slice(0, 200), body.slice(0, 1000), link]);
}
