import { DateTime } from 'luxon';
import type { SeedCtx } from './types.js';

/**
 * Fictional DEMO fixtures for Insights: ~12 weeks of older recorded work (before the base seed's last 10 working days),
 * so weekly trends, cycle times, blocker causes and estimate accuracy have history. Every task here is closed before the
 * base window starts, so today's plans, boards and open work are unchanged. Plans/recaps skip any date already used.
 */
const ENG = ['Order history API pagination', 'Checkout error-state copy', 'Search index rebuild job', 'Webhook retry backoff', 'Flaky test triage',
  'Address autocomplete spike', 'Portal v2.3 release notes', 'Session timeout handling', 'Image upload resizing', 'Audit log export endpoint',
  'Mobile nav keyboard support', 'Staging database refresh'];
const OPS = ['Laptop refresh for September joiners', 'Vendor SLA review', 'Office access card audit', 'Courier contract renewal', 'Asset register clean-up', 'Desk booking rules'];
const FIN = ['July bank reconciliation', 'Vendor payment run', 'GST return working papers', 'Expense policy update', 'Petty cash audit', 'Quarterly accrual schedule'];
const SALES = ['Globex renewal proposal', 'Pipeline hygiene pass', 'Pricing sheet refresh', 'Partner referral follow-ups', 'Retail case study draft', 'Demo environment reset'];
const LEAD = ['Hiring plan for Q4', 'Board update draft', 'Engineering interview loop', 'Benefits vendor shortlist', 'Annual plan inputs'];
const ADMIN = ['Timesheet corrections', 'Inbox triage', 'Meeting notes clean-up', 'Expense claim', 'Travel booking'];
const CAUSES = ['client', 'client', 'client', 'dependency', 'dependency', 'access', 'requirement'];
const REASON: Record<string, string> = { client: 'Waiting for client feedback on scope', dependency: 'Waiting on an upstream change', access: 'Need access to the staging environment', requirement: 'Acceptance criteria unclear' };

interface Prof { project: string; titles: string[]; category: string; recap: (wk: number) => number; cover: (wk: number) => number; meetings: [number, number][]; reviewer?: string }
const PROF: Record<string, Prof> = {
  asha: { project: 'HIRE', titles: LEAD, category: 'operations', recap: () => 0.75, cover: () => 0.45, meetings: [[660, 30], [900, 60]] },
  vikram: { project: 'SALES', titles: SALES, category: 'sales', recap: () => 0.6, cover: () => 0.5, meetings: [[660, 30], [840, 90], [990, 45]] },
  priya: { project: 'WEB', titles: ENG, category: 'delivery', recap: () => 0.95, cover: () => 0.7, meetings: [[660, 30], [960, 30]], reviewer: 'rahul' },
  rahul: { project: 'WEB', titles: ENG, category: 'delivery', recap: () => 0.97, cover: () => 0.85, meetings: [[660, 30]], reviewer: 'priya' },
  sara: { project: 'WEB', titles: ENG, category: 'delivery', recap: () => 0.97, cover: () => 0.85, meetings: [[660, 30]], reviewer: 'priya' },
  dev: { project: 'OPS', titles: OPS, category: 'operations', recap: (wk) => (wk <= 4 ? 0.5 : 0.9), cover: () => 0.6, meetings: [[660, 30]] },
  meera: { project: 'FIN', titles: FIN, category: 'finance', recap: (wk) => (wk <= 4 ? 0.55 : 0.9), cover: () => 0.65, meetings: [[660, 30]] },
  kabir: { project: 'SALES', titles: SALES, category: 'sales', recap: () => 0.7, cover: () => 0.55, meetings: [[660, 30], [840, 90], [990, 45]] },
};
const MANAGER: Record<string, string> = { rahul: 'priya', sara: 'priya', dev: 'asha', meera: 'asha', kabir: 'asha', priya: 'asha' };

export default async function seed(ctx: SeedCtx) {
  const { q, q1, ins, U, P, T, today } = ctx;
  let s = 16031;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const pick = <X,>(a: X[]) => a[Math.floor(rnd() * a.length)];
  const lastWorkday = (n: number) => { let d = today; let k = 0; while (k < n) { d = d.minus({ days: 1 }); if (d.weekday <= 5) k++; } return d; };
  const baseStart = lastWorkday(10);
  const histStart = today.startOf('week').minus({ weeks: 12 });
  const insSkip = (table: string, row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    return q1(`insert into ${table} (tenant_id, ${keys.join(',')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) on conflict do nothing returning *`, [T, ...keys.map((k) => row[k])]);
  };
  const at = (d: DateTime, minute: number) => d.startOf('day').plus({ minutes: minute }).toJSDate();
  const leaveMon = today.startOf('week').minus({ weeks: 6 });
  await ins('leave_entries', { user_id: U.meera, start_date: leaveMon.toISODate(), end_date: leaveMon.plus({ days: 4 }).toISODate(), portion: 'full', kind: 'leave', note: 'Annual leave (DEMO)', created_by: U.asha });

  const hist = (t: any, from: string | null, to: string, when: Date, actor: string, reason: string | null = null) =>
    ins('task_state_history', { task_id: t.id, from_status: from, to_status: to, actor_id: actor, reason, at: when });
  const finish = async (t: any, when: Date, actor: string) => {
    await hist(t, t.status, 'done', when, actor, actor === t.owner_id ? null : 'Accepted');
    await q(`update tasks set status = 'done', done_at = $2, accepted_at = $2, updated_at = $2, version = version + 1 where id = $1`, [t.id, when]);
    t.status = 'done';
  };
  const days: DateTime[] = [];
  for (let d = histStart; d < baseStart; d = d.plus({ days: 1 })) days.push(d);

  for (const k of Object.keys(PROF)) {
    const pf = PROF[k], uid = U[k];
    const startMin = k === 'sara' ? 600 : 570, endMin = 1080, brk = k === 'sara' ? 45 : 60;
    let main: any = null, left = 0, idx = Math.floor(rnd() * pf.titles.length), reviewDue: DateTime | null = null, blocker: any = null, lastDay: DateTime | null = null;
    const newMain = async (d: DateTime) => {
      const len = 1 + Math.floor(rnd() * 4);
      const review = pf.category === 'delivery' && pf.reviewer;
      const t = await ins('tasks', { title: pf.titles[idx++ % pf.titles.length], owner_id: uid, created_by: uid, status: 'in_progress', priority: pick(['high', 'medium', 'medium', 'low']),
        category: pf.category, project_id: P[pf.project].id, due_date: d.plus({ days: len + Math.floor(rnd() * 4) - 1 }).toISODate(),
        estimate_minutes: rnd() < 0.8 ? Math.round(((len + 1) * 200 * (0.6 + rnd() * 0.7)) / 30) * 30 : null,
        requires_review: !!review, reviewer_id: review ? U[pf.reviewer!] : null, requires_evidence: pf.category === 'finance',
        started_at: at(d, startMin + 15), created_at: at(d, startMin + 5), updated_at: at(d, startMin + 15) });
      await hist(t, null, 'planned', at(d, startMin + 5), uid);
      await hist(t, 'planned', 'in_progress', at(d, startMin + 15), uid, 'Started');
      t.status = 'in_progress'; main = t; left = len;
    };
    for (const d of days) {
      const working = k === 'sara' ? d.weekday <= 4 : d.weekday <= 5;
      if (!working || (k === 'meera' && d >= leaveMon && d <= leaveMon.plus({ days: 4 }))) continue;
      lastDay = d;
      const wk = Math.round(today.startOf('week').diff(d.startOf('week'), 'weeks').weeks);
      // Morning: pending review decision, blocker resolution.
      if (main && reviewDue && d >= reviewDue) {
        reviewDue = null;
        if (!main.reworked && rnd() < 0.3) {
          await ins('task_reviews', { task_id: main.id, reviewer_id: U[pf.reviewer!], decision: 'changes_requested', note: 'Cover the empty state and add a test', created_at: at(d, 615) });
          await hist(main, 'in_review', 'in_progress', at(d, 615), U[pf.reviewer!], 'Changes requested: cover the empty state and add a test');
          await q(`update tasks set status = 'in_progress', reopen_count = reopen_count + 1 where id = $1`, [main.id]);
          main.status = 'in_progress'; main.reworked = true; left = 1;
        } else {
          await ins('task_reviews', { task_id: main.id, reviewer_id: U[pf.reviewer!], decision: 'accepted', note: 'Looks good', created_at: at(d, 615) });
          await finish(main, at(d, 615), U[pf.reviewer!]);
          main = null;
        }
      }
      if (blocker && d >= blocker.until) {
        await q(`update blockers set resolved_at = $2, resolved_by = $3, resolution = 'Unblocked' where id = $1`, [blocker.id, at(d, 660), uid]);
        await hist(main, 'blocked', 'in_progress', at(d, 660), uid, 'Blocker resolved');
        main.status = 'in_progress'; blocker = null;
      }
      if (!main) await newMain(d);
      // Occasional quick admin task, done the same day.
      const admin = rnd() < 0.3 ? await ins('tasks', { title: pick(ADMIN), owner_id: uid, created_by: uid, status: 'in_progress', category: 'admin', estimate_minutes: 30,
        project_id: null, started_at: at(d, startMin + 20), created_at: at(d, startMin + 10), updated_at: at(d, startMin + 20) }) : null;
      if (admin) { await hist(admin, null, 'planned', at(d, startMin + 10), uid); await hist(admin, 'planned', 'in_progress', at(d, startMin + 20), uid); admin.status = 'in_progress'; }
      // Plan (skipped if another fixture already planned this date).
      const plan = await insSkip('daily_plans', { user_id: uid, date: d.toISODate(), created_at: at(d, startMin + 8) });
      if (plan) {
        let pos = 1;
        if (main.status === 'in_progress') await ins('daily_plan_items', { plan_id: plan.id, task_id: main.id, position: pos++, added_at: at(d, startMin + 9) });
        if (admin) await ins('daily_plan_items', { plan_id: plan.id, task_id: admin.id, position: pos++, added_at: at(d, startMin + 11) });
      }
      // Time: meetings from the calendar, then work blocks around meetings and lunch.
      const busy: [number, number][] = [...pf.meetings.map(([m, l]) => [m, m + l] as [number, number]), [780, 840]];
      for (const [m, l] of pf.meetings) await ins('time_entries', { user_id: uid, category: 'meeting', source: 'calendar', note: m === 660 ? 'Daily stand-up' : 'Client sync',
        started_at: at(d, m), ended_at: at(d, m + l), created_at: at(d, m) });
      const meetingMin = pf.meetings.reduce((x, [, l]) => x + l, 0);
      let remaining = Math.round(pf.cover(wk) * (endMin - startMin - brk) * (0.8 + rnd() * 0.4)) - meetingMin;
      let cursor = startMin + 15, first = true;
      busy.sort((a, b) => a[0] - b[0]);
      while (remaining >= 30 && cursor < endMin - 30) {
        const next = busy.find(([b0, b1]) => b1 > cursor) ?? [endMin, endMin];
        if (next[0] <= cursor) { cursor = next[1] + 5; continue; }
        const free = next[0] - cursor;
        if (free < 30) { cursor = next[1] + 5; continue; }
        const want = admin && first ? 30 + Math.floor(rnd() * 2) * 15 : 45 + Math.floor(rnd() * 6) * 15;
        const len = Math.min(free, want, remaining);
        const learning = pf.category === 'delivery' && d.weekday === 5 && !first && rnd() < 0.5;
        const taskId = admin && first ? admin.id : learning || main.status !== 'in_progress' ? null : main.id;
        await ins('time_entries', { user_id: uid, task_id: taskId, category: learning ? 'learning' : taskId || main.status === 'in_progress' ? 'task' : 'admin',
          source: rnd() < 0.7 ? 'timer' : 'manual', started_at: at(d, cursor), ended_at: at(d, cursor + len), created_at: at(d, cursor) });
        remaining -= len; cursor += len + 5; first = false;
      }
      if (admin) await finish(admin, at(d, endMin - 60), uid);
      // Progress the main task: occasional blocker, otherwise count down to completion.
      if (main.status === 'in_progress' && !reviewDue) {
        if (rnd() < 0.08) {
          const cause = pick(CAUSES);
          const b = await ins('blockers', { task_id: main.id, reason: REASON[cause], cause, raised_by: uid, raised_at: at(d, 720),
            ...(cause === 'client' ? { waiting_on_text: 'Globex IT team' } : { waiting_on_user_id: cause === 'access' ? U.dev : U.priya }) });
          await hist(main, 'in_progress', 'blocked', at(d, 720), uid);
          main.status = 'blocked';
          let until = d.plus({ days: 1 + Math.floor(rnd() * 3) }); while (until.weekday > 5) until = until.plus({ days: 1 });
          blocker = { id: b.id, until };
        } else if (--left <= 0) {
          if (main.requires_evidence) await ins('evidence_links', { task_id: main.id, kind: 'link', label: 'Working paper (DEMO link)', url: 'https://example.com/demo/working-paper', added_by: uid, created_at: at(d, endMin - 40) });
          if (main.requires_review) {
            await hist(main, 'in_progress', 'in_review', at(d, endMin - 30), uid, 'Submitted for review');
            await q(`update tasks set status = 'in_review' where id = $1`, [main.id]);
            main.status = 'in_review';
            reviewDue = d.plus({ days: 1 });
          } else { await finish(main, at(d, endMin - 30), uid); main = null; }
        }
      }
      // Recap
      if (rnd() < pf.recap(wk)) {
        const rev = await insSkip('daily_reviews', { user_id: uid, date: d.toISODate(), status: 'confirmed', summary: `Worked on ${main?.title ?? 'closing out the week'}.`,
          next_steps: 'Continue planned work', version: 1, confirmed_at: at(d, endMin - 5), updated_at: at(d, endMin - 5) });
        if (rev) {
          await ins('daily_review_versions', { review_id: rev.id, version: 1, snapshot: { summary: rev.summary, nextSteps: rev.next_steps, dayType: 'work' }, change_reason: 'Confirmed', created_by: uid, created_at: at(d, endMin - 5) });
          if (MANAGER[k] && rnd() < 0.4) await q(`update daily_reviews set status = 'manager_reviewed', reviewed_at = $2, reviewed_by = $3 where id = $1`, [rev.id, at(d.plus({ days: 1 }), 600), U[MANAGER[k]]]);
        }
      }
    }
    // Close anything still open before the base window starts.
    if (main && lastDay) {
      if (blocker) { await q(`update blockers set resolved_at = $2, resolved_by = $3, resolution = 'Unblocked' where id = $1`, [blocker.id, at(lastDay, 960), uid]); await hist(main, 'blocked', 'in_progress', at(lastDay, 960), uid); main.status = 'in_progress'; }
      if (main.requires_evidence) await ins('evidence_links', { task_id: main.id, kind: 'link', label: 'Working paper (DEMO link)', url: 'https://example.com/demo/working-paper', added_by: uid, created_at: at(lastDay, 1000) });
      if (main.requires_review) await ins('task_reviews', { task_id: main.id, reviewer_id: U[pf.reviewer!], decision: 'accepted', note: 'Looks good', created_at: at(lastDay, 1020) });
      await finish(main, at(lastDay, 1020), main.requires_review ? U[pf.reviewer!] : uid);
    }
  }
}
