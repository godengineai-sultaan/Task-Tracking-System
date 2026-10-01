import type { DateTime } from 'luxon';
import type pg from 'pg';

/** Context handed to each feature area's demo-fixture seeder (owner role, inside the seed transaction). */
export interface SeedCtx {
  c: pg.Client;
  q: (sql: string, p?: unknown[]) => Promise<any[]>;
  q1: (sql: string, p?: unknown[]) => Promise<any>;
  /** Insert a row into a tenant table (tenant_id added automatically); returns the row. */
  ins: (table: string, row: Record<string, unknown>) => Promise<any>;
  T: string;                              // tenant id
  U: Record<string, string>;              // user ids by key: asha, vikram, priya, rahul, sara, dev, meera, kabir, lena
  P: Record<string, any>;                 // projects by key: WEB, OPS, FIN, SALES, HIRE
  M: Record<string, any>;                 // milestones: web1, web2, fin1, ops1
  tasks: any[];                           // seeded tasks (each has .spec.owner key)
  today: DateTime;                        // start of today in TZ
  TZ: string;
}
