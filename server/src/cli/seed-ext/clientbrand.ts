import { crc32, deflateSync } from 'node:zlib';
import type { SeedCtx } from './types.js';
import { storeFile } from '../../lib/storage.js';
import { buildHighlights, weekPeriod } from '../../services/ext/clientbrand.js';

/** A small fictional "N" mark as an RGBA PNG (no image dependencies): teal rounded square, white letterform, 4x supersampled. */
function demoLogoPng(size = 128) {
  const inside = (x: number, y: number) => {
    const r = 28, cx = Math.min(Math.max(x, r), size - r), cy = Math.min(Math.max(y, r), size - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return 0;
    const bar = y >= 32 && y <= 96 && ((x >= 34 && x <= 50) || (x >= 78 && x <= 94));
    const diag = y >= 32 && y <= 96 && x >= 34 && x <= 94 && Math.abs(64 * (x - 34) - 60 * (y - 32)) / Math.hypot(64, 60) <= 9;
    return bar || diag ? 2 : 1;
  };
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) { const v = inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4); if (v === 1) bg++; else if (v === 2) fg++; }
      const cover = (bg + fg) / 16, t = fg / Math.max(1, bg + fg);
      const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
      row.set([mix(0x0f, 255), mix(0x76, 255), mix(0x6e, 255), Math.round(cover * 255)], 1 + x * 4);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** Fictional DEMO fixtures for the 'clientbrand' feature area: branding plus a published and a draft client update for Globex. */
export default async function seed(ctx: SeedCtx) {
  const { c, q, ins, T, U, P, M, today } = ctx;
  const db = c as any;
  // A few more client-visible deliverables on the Globex project so the weekly updates have something to report.
  const lastWeekDay = today.minus({ weeks: 1 }).startOf('week').plus({ days: 2, hours: 15 });
  const thisWeekDay = (today.weekday === 1 ? today : today.minus({ days: 1 })).set({ hour: 16 });
  for (const [title, status, milestone, due, doneAt] of [
    ['Order status webhooks for Globex ERP', 'done', M.web1, today.minus({ days: 5 }), lastWeekDay],
    ['Order history export (CSV)', 'done', M.web1, today, thisWeekDay],
    ['Order tracking email templates', 'in_progress', M.web1, today.plus({ days: 3 }), null],
    ['Accessibility review of tracking page', 'planned', M.web1, today.plus({ days: 8 }), null],
    ['UAT test scripts for Globex', 'planned', M.web2, today.plus({ days: 15 }), null],
  ] as const) {
    const created = today.minus({ days: 12 }).set({ hour: 10 });
    const t = await ins('tasks', { project_id: P.WEB.id, milestone_id: milestone.id, title, owner_id: U.priya, created_by: U.priya, status, priority: 'medium', category: 'delivery',
      due_date: due.toISODate(), estimate_minutes: 120, customer_visible: true, started_at: status === 'planned' ? null : created.plus({ days: 1 }).toJSDate(),
      done_at: doneAt?.toJSDate() ?? null, accepted_at: doneAt?.toJSDate() ?? null, created_at: created.toJSDate(), updated_at: (doneAt ?? created).toJSDate() });
    await ins('task_state_history', { task_id: t.id, from_status: null, to_status: 'planned', actor_id: U.priya, reason: 'Created (DEMO fixture)', at: created.toJSDate() });
    if (doneAt) await ins('task_state_history', { task_id: t.id, from_status: 'in_progress', to_status: 'done', actor_id: U.priya, reason: 'Delivered (DEMO fixture)', at: doneAt.toJSDate() });
  }

  const logo = await storeFile(db, T, demoLogoPng(), 'logo.png', 'image/png', 'import', U.asha);
  await q(`update stored_files set purpose = 'branding' where id = $1`, [logo.id]);
  await ins('tenant_branding', { accent: '#0f766e', logo_file_id: logo.id, weekly_drafts: true, updated_by: U.asha });

  const last = weekPeriod(today.minus({ weeks: 1 }));
  const publishedAt = today.minus({ weeks: 1 }).startOf('week').plus({ days: 4, hours: 16 });
  await ins('client_updates', {
    project_id: P.WEB.id, customer_id: P.WEB.customer_id, period_start: last.start, period_end: last.end, status: 'published', source: 'manual',
    summary: 'Good progress on the order tracking beta this week. The completed items are listed below. Next week we focus on the remaining tracking '
      + 'features and on preparing the UAT plan with your team. Please send any feedback on the tracking page to Priya.',
    highlights: await buildHighlights(db, T, P.WEB.id, last.start, last.end),
    created_by: U.priya, updated_by: U.priya, published_by: U.priya, published_at: publishedAt.toJSDate(), version: 3,
    created_at: publishedAt.minus({ hours: 3 }).toJSDate(), updated_at: publishedAt.toJSDate(),
  });
  const week = weekPeriod(today);
  await ins('client_updates', {
    project_id: P.WEB.id, customer_id: P.WEB.customer_id, period_start: week.start, period_end: week.end, status: 'draft', source: 'scheduled', summary: '',
    highlights: await buildHighlights(db, T, P.WEB.id, week.start, week.end),
  });
}
