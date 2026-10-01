import type { DateTime } from 'luxon';
import type { SeedCtx } from './types.js';

/**
 * Fictional DEMO fixtures for the 'trends' feature area.
 * The core seed simulates the last 10 working days; this adds ~10 earlier weeks of plausible history for six people
 * (plans, confirmed time, recaps, accepted tasks with estimates, a few blockers, a leave week) so the 12-week trends
 * and pattern review have something real to show. Deterministic (own PRNG), all names fictional.
 */
type Spec = [title: string, cat: string, project?: string];
const PEOPLE: Record<string, { specs: Spec[]; factor: Record<string, number>; meetings: (wd: number) => [number, number, string][]; fragmented: (wd: number, r: number) => boolean }> = {
  rahul: {
    specs: [['Prototype order search indexing', 'research', 'WEB'], ['Checkout address validation', 'delivery', 'WEB'], ['Support rotation: client ticket batch', 'support', 'WEB'],
      ['Benchmark cache eviction strategies', 'research', 'WEB'], ['Refactor order sync retries', 'delivery', 'WEB'], ['Spike: event streaming options', 'research', 'WEB'],
      ['Delivery slot API', 'delivery', 'WEB'], ['Triage escalated client tickets', 'support', 'WEB']],
    factor: { research: 1.8, delivery: 1.15, support: 0.8 },
    meetings: (wd) => [[600, 615, 'Engineering stand-up'], ...(wd === 3 ? [[810, 1050, 'Sprint planning & Globex workshop']] as [number, number, string][] : [])],
    fragmented: (wd) => wd === 2 || wd === 5,
  },
  sara: {
    specs: [['Order list empty states', 'delivery', 'WEB'], ['Accessibility pass: checkout forms', 'delivery', 'WEB'], ['Research date-picker components', 'research', 'WEB'],
      ['Mobile navigation redesign', 'delivery', 'WEB'], ['Tracking page loading states', 'delivery', 'WEB']],
    factor: { delivery: 1.5, research: 1.0 },
    meetings: (wd) => [[630, 645, 'Engineering stand-up'], ...(wd === 4 ? [[900, 960, 'Design review']] as [number, number, string][] : [])],
    fragmented: (_wd, r) => r < 0.25,
  },
  priya: {
    specs: [['Quarterly hiring plan draft', 'admin', 'HIRE'], ['Evaluate observability vendors', 'research', 'WEB'], ['Architecture review: payments', 'delivery', 'WEB'],
      ['Sprint planning prep', 'admin'], ['Team onboarding guide update', 'admin']],
    factor: { admin: 0.9, research: 1.6, delivery: 1.0 },
    meetings: (wd) => [[600, 615, 'Engineering stand-up'], ...(wd === 2 || wd === 4 ? [[840, 1020, '1:1s']] as [number, number, string][] : []), ...(wd === 4 ? [[660, 720, 'Hiring panel']] as [number, number, string][] : [])],
    fragmented: (_wd, r) => r < 0.4,
  },
  kabir: {
    specs: [['Prepare Initech renewal proposal', 'sales', 'SALES'], ['Pipeline clean-up', 'sales', 'SALES'], ['Market sizing: logistics vertical', 'research', 'SALES'], ['Demo script refresh', 'sales', 'SALES']],
    factor: { sales: 1.1, research: 1.5 },
    meetings: (wd) => [[660, 750, 'Client calls'], ...(wd === 1 ? [[840, 960, 'Pipeline review']] as [number, number, string][] : [])],
    fragmented: (_wd, r) => r < 0.5,
  },
  dev: {
    specs: [['Vendor contract renewals', 'operations', 'OPS'], ['Laptop fleet audit', 'operations', 'OPS'], ['Office access card process', 'admin', 'OPS'], ['Backup restore drill', 'operations', 'OPS']],
    factor: { operations: 1.0, admin: 0.7 },
    meetings: (wd) => (wd === 1 ? [[600, 630, 'Ops sync']] : []),
    fragmented: (_wd, r) => r < 0.3,
  },
  meera: {
    specs: [['Month-end accruals', 'finance', 'FIN'], ['Vendor invoice reconciliation', 'finance', 'FIN'], ['Expense policy FAQ', 'admin'], ['GST filing preparation', 'finance', 'FIN']],
    factor: { finance: 1.45, admin: 0.9 },
    meetings: (wd) => (wd === 1 ? [[600, 630, 'Finance sync']] : []),
    fragmented: (_wd, r) => r < 0.3,
  },
};

export default async function seed(ctx: SeedCtx) {
  const { ins, c, q1, T, U, P, today } = ctx;
  let s = 7177;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const lastWorkday = (n: number) => { let d = today; let k = 0; while (k < n) { d = d.minus({ days: 1 }); if (d.weekday <= 5) k++; } return d; };
  const coreStart = lastWorkday(10); // the core seed simulates from here on
  const first = today.startOf('week').minus({ weeks: 11 });
  const leaveWeek = first.plus({ weeks: 3 });
  await ins('leave_entries', { user_id: U.rahul, start_date: leaveWeek.toISODate(), end_date: leaveWeek.plus({ days: 4 }).toISODate(), portion: 'full', kind: 'leave', note: 'Family trip (DEMO)', created_by: U.priya });
  const saraSick = first.plus({ weeks: 6, days: 1 });
  await ins('leave_entries', { user_id: U.sara, start_date: saraSick.toISODate(), end_date: saraSick.plus({ days: 1 }).toISODate(), portion: 'full', kind: 'sick', created_by: U.priya });
  const onLeave = (k: string, d: DateTime) => (k === 'rahul' && d >= leaveWeek && d < leaveWeek.plus({ days: 5 })) || (k === 'sara' && d >= saraSick && d < saraSick.plus({ days: 2 }));
  const at = (d: DateTime, m: number) => d.startOf('day').plus({ minutes: m }).toJSDate();

  for (const [k, cfg] of Object.entries(PEOPLE)) {
    const sch = k === 'sara' ? { s: 600, e: 1080, wd: 4 } : { s: 570, e: 1080, wd: 5 };
    const active: { id: string; status: string; cat: string; est: number; remaining: number }[] = [];
    let n = 0;
    const newTask = async (d: DateTime) => {
      const [title, cat, project] = cfg.specs[n % cfg.specs.length];
      const round = Math.floor(n / cfg.specs.length); n++;
      const est = [60, 90, 120, 180, 240][Math.floor(rnd() * 5)];
      const t = await ins('tasks', { title: round ? `${title} #${round + 1}` : title, owner_id: U[k], created_by: U[k], status: 'planned', category: cat, project_id: project ? P[project].id : null,
        estimate_minutes: est, priority: 'medium', created_at: at(d, sch.s - 20), updated_at: at(d, sch.s - 20), sort_order: d.toSeconds() });
      await ins('task_state_history', { task_id: t.id, from_status: null, to_status: 'planned', actor_id: U[k], reason: 'Created (DEMO fixture)', at: at(d, sch.s - 20) });
      active.push({ id: t.id, status: 'planned', cat, est, remaining: Math.round(est * (cfg.factor[cat] ?? 1) * (0.85 + rnd() * 0.3)) });
    };
    const setStatus = async (t: (typeof active)[number], to: string, when: Date) => {
      const extra = to === 'done' ? ', done_at = $3, accepted_at = $3' : to === 'in_progress' ? ', started_at = coalesce(started_at, $3)' : '';
      await c.query(`update tasks set status = $2, version = version + 1, updated_at = $3 ${extra} where id = $1`, [t.id, to, when]);
      await ins('task_state_history', { task_id: t.id, from_status: t.status, to_status: to, actor_id: U[k], reason: to === 'done' ? 'Done (DEMO fixture)' : null, at: when });
      t.status = to;
    };
    for (let d = first; d < coreStart; d = d.plus({ days: 1 })) {
      if (d.weekday > sch.wd || onLeave(k, d)) continue;
      while (active.length < 3) await newTask(d);
      const planned = active.slice(0, 2 + (rnd() < 0.5 ? 1 : 0));
      // Tolerate plans/recaps another area may already have seeded for the same person and date.
      const plan = await q1(`insert into daily_plans (tenant_id, user_id, date, created_at) values ($1,$2,$3,$4) on conflict (user_id, date) do nothing returning id`, [T, U[k], d.toISODate(), at(d, sch.s + 5)]);
      if (!plan) continue;
      for (let i = 0; i < planned.length; i++) await ins('daily_plan_items', { plan_id: plan.id, task_id: planned[i].id, position: i + 1, added_at: at(d, sch.s + 6) });
      const meetings = cfg.meetings(d.weekday);
      for (const [m0, m1, title] of meetings) await ins('time_entries', { user_id: U[k], category: 'meeting', started_at: at(d, m0), ended_at: at(d, m1), source: 'calendar', note: title, created_at: at(d, m0) });
      const busy = [...meetings.map(([a, b]) => [a, b] as [number, number]), [780, 825] as [number, number]].sort((x, y) => x[0] - y[0]); // lunch is unlogged
      const frag = cfg.fragmented(d.weekday, rnd());
      const target = (sch.e - sch.s - 60) * (0.55 + rnd() * 0.35) - meetings.reduce((x, [a, b]) => x + b - a, 0);
      let cursor = sch.s + 10, logged = 0, idx = 0;
      while (logged < target && cursor < sch.e - 15 && planned.some((t) => t.status !== 'done')) {
        const inBusy = busy.find(([a, b]) => cursor >= a && cursor < b);
        if (inBusy) { cursor = inBusy[1] + 5; continue; }
        const nextBusy = busy.find(([a]) => a > cursor)?.[0] ?? sch.e;
        const open = planned.filter((t) => t.status !== 'done');
        const t = open[(frag ? idx++ : 0) % open.length];
        let len = frag ? 25 + Math.floor(rnd() * 4) * 5 : 60 + Math.floor(rnd() * 7) * 15;
        len = Math.min(len, nextBusy - cursor, Math.max(15, t.remaining));
        if (len < 15) { cursor = nextBusy; continue; }
        if (t.status === 'planned') await setStatus(t, 'in_progress', at(d, cursor));
        await ins('time_entries', { user_id: U[k], task_id: t.id, category: 'task', started_at: at(d, cursor), ended_at: at(d, cursor + len), source: rnd() < 0.7 ? 'timer' : 'manual', created_at: at(d, cursor) });
        t.remaining -= len; logged += len; cursor += len + (frag ? 5 : 10);
        if (t.remaining <= 0) { await setStatus(t, 'done', at(d, cursor - 5)); active.splice(active.indexOf(t), 1); }
      }
      if (rnd() < 0.06) {
        const t = active.find((x) => x.status === 'in_progress');
        if (t) {
          const raised = at(d, Math.min(Math.max(cursor, 900), sch.e - 30)), resolved = at(d.plus({ days: 1 }), 540); // resolved before the next working morning
          await ins('blockers', { task_id: t.id, reason: 'Waiting for staging credentials (DEMO)', cause: 'access', waiting_on_user_id: U.dev, raised_by: U[k], raised_at: raised,
            resolved_at: resolved, resolved_by: U[k], resolution: 'Access granted', next_follow_up: d.plus({ days: 1 }).toISODate() });
          await setStatus(t, 'blocked', raised);
          await setStatus(t, 'in_progress', resolved);
        }
      }
      if (rnd() < 0.85) {
        const when = at(d, sch.e - 5);
        const rev = await q1(`insert into daily_reviews (tenant_id, user_id, date, status, summary, version, confirmed_at, updated_at) values ($1,$2,$3,'confirmed',$4,1,$5,$5)
          on conflict (user_id, date) do nothing returning id, summary`, [T, U[k], d.toISODate(), `Progressed ${planned.length} planned outcome(s). (DEMO)`, when]);
        if (rev) await ins('daily_review_versions', { review_id: rev.id, version: 1, snapshot: { summary: rev.summary, blockersNote: '', nextSteps: '', dayType: 'work' }, change_reason: 'Confirmed', created_by: U[k], created_at: when });
      }
    }
  }
}
