/**
 * DEMO FIXTURES — clearly labelled sample data for development and demos.
 * Creates the organization "Northwind Labs (DEMO DATA)" with slug `demo`. Every name, project and number here is fictional.
 * Re-running replaces the demo tenant only. Never run against a production database with real tenants named `demo`.
 * Credentials are written to .data/demo-credentials.txt (git-ignored), not printed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import pg from 'pg';
import { config } from '../lib/config.js';
import { hashPassword, newToken, encrypt } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { migrate } from './migrate.js';

const TZ = 'Asia/Kolkata';
let seed = 20261001;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];

async function main() {
  await migrate();
  const c = new pg.Client({ connectionString: config.migrationDatabaseUrl });
  await c.connect();
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p).then((r) => r.rows);
  const q1 = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  await c.query('begin');
  await c.query(`set local app.audit_purge = 'on'`);
  await c.query(`delete from tenants where slug = 'demo'`);
  const password = process.env.SEED_PASSWORD || newToken(12);
  const hash = await hashPassword(password);
  const today = DateTime.now().setZone(TZ).startOf('day');

  const tenant = await q1(`insert into tenants (slug, name, legal_name, timezone, plan, seat_limit, modules, settings, onboarded_at, contact_email)
    values ('demo','Northwind Labs (DEMO DATA)','Northwind Labs Pvt Ltd (fictional)',$1,'organization',50,
      array['tasks','analytics','admin_routine','integrations','customer_portal'],$2, now(), 'ops@northwind.example') returning *`,
    [TZ, { founders_visible_to_routine_admin: true, include_meetings_in_work_policy: true, coverage_threshold: 0.5, retention_days: 730, ai_enabled: false,
      voice_capture_enabled: false, evidence_required_categories: ['finance'], review_required_categories: ['delivery'] }]);
  const T = tenant.id;
  const ins = (table: string, row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    return q1(`insert into ${table} (tenant_id, ${keys.join(',')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) returning *`, [T, ...keys.map((k) => row[k])]);
  };

  const dept: Record<string, string> = {};
  for (const n of ['Leadership', 'Engineering', 'Operations', 'Finance', 'Sales']) dept[n] = (await ins('departments', { name: n })).id;
  const rp: Record<string, string> = {};
  for (const [name, desc, ct, cov, judge, guide] of [
    ['General', 'Default profile', 0.6, 0.5, true, ''],
    ['Founder / Leadership', 'Negotiations, hiring and strategy rarely map to closed-task counts', 0.5, 0.4, false, 'Judge by declared outcomes and decisions, not task counts.'],
    ['Engineering', 'Delivery work with peer review', 0.6, 0.5, true, 'Research spikes and incidents can be valuable with few closed tasks.'],
    ['Operations & Finance', 'Procurement, close and admin', 0.65, 0.5, true, 'Evidence is required for finance deliverables.'],
    ['Sales', 'Pipeline and client work', 0.5, 0.4, false, 'Judge by client outcomes; meetings are expected to dominate.'],
  ] as const) rp[name] = (await ins('role_profiles', { name, description: desc, commitment_target: ct, coverage_target: cov, judge_by_closed_tasks: judge, outcome_guidance: guide })).id;
  const globex = (await ins('customers', { name: 'Globex Retail (fictional client)' })).id;

  const people = [
    { key: 'asha', name: 'Asha Rao', email: 'asha@northwind.example', title: 'Founder & CEO', dept: 'Leadership', founder: true, profile: 'Founder / Leadership',
      roles: ['member', 'system_admin', 'routine_admin', 'leadership', 'cost_viewer', 'manager'] },
    { key: 'vikram', name: 'Vikram Mehta', email: 'vikram@northwind.example', title: 'Co-founder, Sales', dept: 'Leadership', founder: true, profile: 'Founder / Leadership', roles: ['member', 'leadership'] },
    { key: 'priya', name: 'Priya Nair', email: 'priya@northwind.example', title: 'Engineering Manager', dept: 'Engineering', profile: 'Engineering', roles: ['member', 'manager'] },
    { key: 'rahul', name: 'Rahul Verma', email: 'rahul@northwind.example', title: 'Software Engineer', dept: 'Engineering', profile: 'Engineering', roles: ['member'] },
    { key: 'sara', name: 'Sara Khan', email: 'sara@northwind.example', title: 'Software Engineer (Mon–Thu)', dept: 'Engineering', profile: 'Engineering', roles: ['member'] },
    { key: 'dev', name: 'Dev Patel', email: 'dev@northwind.example', title: 'Operations Lead', dept: 'Operations', profile: 'Operations & Finance', roles: ['member'] },
    { key: 'meera', name: 'Meera Iyer', email: 'meera@northwind.example', title: 'Finance Executive', dept: 'Finance', profile: 'Operations & Finance', roles: ['member'] },
    { key: 'kabir', name: 'Kabir Singh', email: 'kabir@northwind.example', title: 'Account Executive', dept: 'Sales', profile: 'Sales', roles: ['member'] },
  ];
  const U: Record<string, string> = {};
  for (const p of people) U[p.key] = (await ins('users', { email: p.email, name: p.name, password_hash: hash, roles: p.roles, title: p.title, department_id: dept[p.dept],
    role_profile_id: rp[p.profile], is_founder: !!p.founder, last_login_at: new Date() })).id;
  U.lena = (await ins('users', { email: 'lena@globex.example', name: 'Lena Fischer (client)', password_hash: hash, roles: ['customer'], title: 'Client stakeholder', customer_id: globex })).id;

  const eng = await ins('teams', { name: 'Engineering', manager_id: U.priya, department_id: dept.Engineering });
  for (const k of ['rahul', 'sara']) await ins('team_members', { team_id: eng.id, user_id: U[k] });
  const ops = await ins('teams', { name: 'Operations, Finance & Sales', manager_id: U.asha, department_id: dept.Operations });
  for (const k of ['dev', 'meera', 'kabir', 'priya']) await ins('team_members', { team_id: ops.id, user_id: U[k] });

  for (let wd = 1; wd <= 5; wd++) await ins('work_schedules', { weekday: wd, start_minute: 570, end_minute: 1080, break_minutes: 60 }); // 09:30–18:00
  for (let wd = 1; wd <= 4; wd++) await ins('work_schedules', { user_id: U.sara, weekday: wd, start_minute: 600, end_minute: 1080, break_minutes: 45 });
  await ins('holidays', { date: '2026-10-02', name: 'Gandhi Jayanti' });
  await ins('holidays', { date: '2026-11-09', name: 'Diwali (observed)' });
  const lastWorkday = (n: number) => { let d = today; let k = 0; while (k < n) { d = d.minus({ days: 1 }); if (d.weekday <= 5) k++; } return d.toISODate()!; };
  const rahulLeave = lastWorkday(2);
  await ins('leave_entries', { user_id: U.rahul, start_date: rahulLeave, end_date: rahulLeave, portion: 'full', kind: 'sick', created_by: U.priya });
  await ins('leave_entries', { user_id: U.meera, start_date: today.toISODate(), end_date: today.toISODate(), portion: 'half_pm', kind: 'leave', note: 'Personal appointment', created_by: U.meera });
  await ins('leave_entries', { user_id: U.kabir, start_date: today.plus({ days: 5 }).toISODate(), end_date: today.plus({ days: 7 }).toISODate(), portion: 'full', kind: 'leave', created_by: U.asha });

  const obj = await ins('objectives', { title: 'Launch Globex customer portal v2 by November', owner_id: U.asha, period_start: '2026-07-01', period_end: '2026-12-31' });
  const obj2 = await ins('objectives', { title: 'Close Q3 books within 10 working days', owner_id: U.vikram, period_start: '2026-10-01', period_end: '2026-10-15' });
  const P: Record<string, any> = {};
  for (const [key, name, d, owner, cust, vis, outcome, target] of [
    ['WEB', 'Globex portal v2', 'Engineering', 'priya', globex, 'company', 'Client can self-serve order tracking; reduces support tickets', '2026-11-20'],
    ['OPS', 'Office procurement', 'Operations', 'dev', null, 'company', 'New hires equipped on day one', '2026-10-31'],
    ['FIN', 'Q3 close', 'Finance', 'meera', null, 'company', 'Books closed and reconciled', '2026-10-15'],
    ['SALES', 'Enterprise pipeline', 'Sales', 'vikram', null, 'company', 'Two enterprise contracts signed this quarter', '2026-12-31'],
    ['HIRE', 'Leadership hiring (private)', 'Leadership', 'asha', null, 'private', 'Hire a VP Engineering', '2026-12-15'],
  ] as const) {
    P[key] = await ins('projects', { key, name, department_id: dept[d], owner_id: U[owner], customer_id: cust, visibility: vis, business_outcome: outcome, target_date: target, start_date: '2026-08-01' });
    await ins('project_members', { project_id: P[key].id, user_id: U[owner] });
  }
  for (const k of ['rahul', 'sara']) await ins('project_members', { project_id: P.WEB.id, user_id: U[k] });
  await ins('project_members', { project_id: P.HIRE.id, user_id: U.vikram });
  const M: Record<string, any> = {};
  M.web1 = await ins('milestones', { project_id: P.WEB.id, objective_id: obj.id, name: 'Order tracking beta', due_date: today.plus({ days: 12 }).toISODate() });
  M.web2 = await ins('milestones', { project_id: P.WEB.id, objective_id: obj.id, name: 'Client UAT sign-off', due_date: today.plus({ days: 40 }).toISODate() });
  M.fin1 = await ins('milestones', { project_id: P.FIN.id, objective_id: obj2.id, name: 'Reconciliations complete', due_date: today.plus({ days: 6 }).toISODate() });
  M.ops1 = await ins('milestones', { project_id: P.OPS.id, name: 'October joiners equipped', due_date: today.plus({ days: 9 }).toISODate() });
  for (const [u, p, pct, as] of [['rahul', 'WEB', 80, 'Portal is primary; 20% support rotation'], ['sara', 'WEB', 100, 'Part-time Mon–Thu'], ['priya', 'WEB', 50, 'Half management time'],
    ['dev', 'OPS', 70, ''], ['meera', 'FIN', 90, 'Quarter close']] as const)
    await ins('capacity_allocations', { user_id: U[u], project_id: P[p].id, percent: pct, start_date: '2026-08-01', assumption: as });
  for (const [u, r] of [['asha', 4500], ['vikram', 4500], ['priya', 2600], ['rahul', 1800], ['sara', 1700], ['dev', 1400], ['meera', 1300], ['kabir', 1500]] as const)
    await ins('cost_rates', { user_id: U[u], hourly_rate: r, currency: 'INR', effective_from: '2026-04-01' });

  // ---------- Task pools ----------
  type Spec = { owner: string; title: string; project?: string; milestone?: string; cat: string; est?: number; review?: string; evidence?: boolean; prio?: string; customer?: boolean; tags?: string[]; accept?: string };
  const specs: Spec[] = [
    { owner: 'rahul', title: 'Order status API endpoint', project: 'WEB', milestone: 'web1', cat: 'delivery', est: 240, review: 'priya', customer: true, accept: 'Returns status for a valid order id; 404 otherwise; documented' },
    { owner: 'rahul', title: 'Fix timezone bug in delivery estimates', project: 'WEB', milestone: 'web1', cat: 'delivery', est: 120, review: 'sara', prio: 'high' },
    { owner: 'rahul', title: 'Add pagination to order history', project: 'WEB', milestone: 'web1', cat: 'delivery', est: 180, review: 'priya', customer: true },
    { owner: 'rahul', title: 'Investigate slow search queries', project: 'WEB', cat: 'research', est: 150 },
    { owner: 'rahul', title: 'Support rotation: triage client tickets', project: 'WEB', cat: 'support', est: 90 },
    { owner: 'rahul', title: 'Write runbook for order sync failures', project: 'WEB', cat: 'delivery', est: 90, review: 'priya' },
    { owner: 'sara', title: 'Tracking page UI', project: 'WEB', milestone: 'web1', cat: 'delivery', est: 300, review: 'rahul', customer: true },
    { owner: 'sara', title: 'Accessibility audit of checkout flow', project: 'WEB', cat: 'delivery', est: 180, review: 'priya', tags: ['a11y'] },
    { owner: 'sara', title: 'Design tokens for portal theme', project: 'WEB', cat: 'delivery', est: 120, review: 'priya' },
    { owner: 'sara', title: 'Notification preferences screen', project: 'WEB', milestone: 'web2', cat: 'delivery', est: 240, review: 'rahul' },
    { owner: 'priya', title: 'Sprint planning for portal v2', project: 'WEB', cat: 'admin', est: 60 },
    { owner: 'priya', title: 'Review UAT plan with Globex', project: 'WEB', milestone: 'web2', cat: 'delivery', est: 90, customer: true },
    { owner: 'priya', title: 'Hiring loop: backend engineer interviews', cat: 'admin', est: 180 },
    { owner: 'priya', title: 'Architecture decision record: event sync', project: 'WEB', cat: 'research', est: 120 },
    { owner: 'dev', title: 'Prepare laptop PO draft for October joiners', project: 'OPS', milestone: 'ops1', cat: 'operations', est: 60, prio: 'high' },
    { owner: 'dev', title: 'Collect vendor quotes for ergonomic chairs', project: 'OPS', cat: 'operations', est: 90 },
    { owner: 'dev', title: 'Renew office internet contract', project: 'OPS', cat: 'operations', est: 45 },
    { owner: 'dev', title: 'Set up accounts for October joiners', project: 'OPS', milestone: 'ops1', cat: 'operations', est: 120 },
    { owner: 'dev', title: 'Office access card audit', project: 'OPS', cat: 'operations', est: 60 },
    { owner: 'meera', title: 'Bank reconciliation — September', project: 'FIN', milestone: 'fin1', cat: 'finance', est: 180, evidence: true, prio: 'high' },
    { owner: 'meera', title: 'Vendor payment run', project: 'FIN', cat: 'finance', est: 90, evidence: true },
    { owner: 'meera', title: 'GST filing preparation', project: 'FIN', milestone: 'fin1', cat: 'finance', est: 240, evidence: true, prio: 'urgent' },
    { owner: 'meera', title: 'Expense claims review', project: 'FIN', cat: 'finance', est: 60, evidence: true },
    { owner: 'kabir', title: 'Globex renewal proposal', project: 'SALES', cat: 'sales', est: 180 },
    { owner: 'kabir', title: 'Discovery call notes: Initech', project: 'SALES', cat: 'sales', est: 45 },
    { owner: 'kabir', title: 'Update CRM pipeline stages', project: 'SALES', cat: 'admin', est: 30 },
    { owner: 'kabir', title: 'Prepare pricing deck for Umbrella Corp', project: 'SALES', cat: 'sales', est: 120 },
    { owner: 'vikram', title: 'Negotiate Initech master agreement', project: 'SALES', cat: 'sales', est: 240 },
    { owner: 'vikram', title: 'Board update: Q3 commercial summary', cat: 'admin', est: 120 },
    { owner: 'vikram', title: 'Partner call with distribution reseller', project: 'SALES', cat: 'sales', est: 60 },
    { owner: 'asha', title: 'VP Engineering shortlist', project: 'HIRE', cat: 'admin', est: 120 },
    { owner: 'asha', title: 'Approve Q4 budget', cat: 'finance', est: 90 },
    { owner: 'asha', title: 'Weekly leadership review', cat: 'admin', est: 60 },
    { owner: 'asha', title: 'Customer advisory call: Globex', project: 'WEB', cat: 'sales', est: 60 },
  ];
  const start = DateTime.fromISO(lastWorkday(10), { zone: TZ });
  // Work keeps arriving: extra tasks per person, created on staggered days.
  const extra: Record<string, [string, string, string?][]> = {
    rahul: [['Refactor order sync retry logic', 'delivery', 'WEB'], ['Load test order status API', 'delivery', 'WEB'], ['Upgrade web framework minor version', 'delivery', 'WEB'], ['Pair with Sara on tracking page', 'delivery', 'WEB']],
    sara: [['Empty and error states for tracking page', 'delivery', 'WEB'], ['Mobile layout fixes', 'delivery', 'WEB'], ['Usability test script', 'research', 'WEB']],
    priya: [['Quarterly goals for engineering team', 'admin'], ['Incident review: checkout outage', 'support', 'WEB'], ['Update engineering onboarding guide', 'admin'], ['Vendor evaluation: error monitoring', 'research']],
    dev: [['Plan seating for new joiners', 'operations', 'OPS'], ['Courier contract comparison', 'operations', 'OPS'], ['Fire safety drill coordination', 'operations'], ['Asset register update', 'operations', 'OPS']],
    meera: [['Payroll input validation', 'finance', 'FIN'], ['TDS reconciliation', 'finance', 'FIN'], ['Petty cash audit', 'finance', 'FIN'], ['Prepare audit schedules', 'finance', 'FIN']],
    kabir: [['Follow-up email to Initech procurement', 'sales', 'SALES'], ['Demo for Hooli', 'sales', 'SALES'], ['Competitor pricing research', 'research', 'SALES'], ['Case study draft: Globex', 'sales', 'SALES']],
    vikram: [['Reseller agreement redlines', 'sales', 'SALES'], ['Investor update call', 'admin'], ['Pricing committee decision', 'sales']],
    asha: [['Interview VP Engineering finalist', 'admin', 'HIRE'], ['Office lease renewal decision', 'operations'], ['All-hands agenda', 'admin']],
  };
  const extraSpecs: (Spec & { arrive: number })[] = [];
  for (const [owner, list] of Object.entries(extra)) list.forEach(([title, cat, project], i) =>
    extraSpecs.push({ owner, title, cat, project, est: [60, 90, 120, 180][i % 4], review: cat === 'delivery' ? (owner === 'rahul' ? 'sara' : owner === 'sara' ? 'rahul' : undefined) : undefined,
      evidence: cat === 'finance', arrive: 2 + i * 3 }));
  const tasks: any[] = [];
  for (const s of [...specs, ...extraSpecs] as (Spec & { arrive?: number })[]) {
    const created = s.arrive !== undefined ? start.plus({ days: s.arrive }).set({ hour: 9, minute: 15 }) : start.minus({ days: Math.floor(rnd() * 5) + 1 }).set({ hour: 10 });
    const due = s.prio === 'urgent' ? today.plus({ days: 2 }) : today.plus({ days: Math.floor(rnd() * 20) - 6 });
    const t = await ins('tasks', { project_id: s.project ? P[s.project].id : null, milestone_id: s.milestone ? M[s.milestone].id : null, title: s.title, owner_id: U[s.owner],
      created_by: U[s.owner], status: 'planned', priority: s.prio ?? pick(['medium', 'medium', 'high', 'low']), category: s.cat, due_date: due.toISODate(), estimate_minutes: s.est ?? null,
      requires_review: !!s.review, reviewer_id: s.review ? U[s.review] : null, requires_evidence: !!s.evidence, customer_visible: !!s.customer, tags: s.tags ?? [],
      acceptance_criteria: s.accept ?? '', created_at: created.toJSDate(), updated_at: created.toJSDate(), sort_order: created.toSeconds() });
    await ins('task_state_history', { task_id: t.id, from_status: null, to_status: 'planned', actor_id: U[s.owner], reason: 'Created (DEMO fixture)', at: created.toJSDate() });
    tasks.push({ ...t, spec: s });
  }
  for (const [ti, txt] of [[0, ['Define response schema', 'Implement handler', 'Unit tests', 'Update API docs']], [19, ['Download statements', 'Match entries', 'Flag exceptions', 'Attach reconciliation sheet']], [14, ['Confirm headcount', 'Get 3 quotes', 'Draft PO']]] as const)
    for (let i = 0; i < txt.length; i++) await ins('checklist_items', { task_id: tasks[ti].id, text: txt[i], position: i, done: i < 2 });
  await ins('task_dependencies', { task_id: tasks[6].id, depends_on_task_id: tasks[0].id });
  await ins('task_dependencies', { task_id: tasks[17].id, depends_on_task_id: tasks[14].id });
  await ins('task_collaborators', { task_id: tasks[11].id, user_id: U.kabir });

  // ---------- Simulate past working days ----------
  const setStatus = async (t: any, to: string, at: DateTime, actor: string, reason: string | null) => {
    const extra: Record<string, unknown> = {};
    if (to === 'in_progress' && !t.started_at) extra.started_at = at.toJSDate();
    if (to === 'done') { extra.done_at = at.toJSDate(); extra.accepted_at = at.toJSDate(); }
    const sets = Object.keys(extra).map((k, i) => `${k} = $${i + 4}`);
    await c.query(`update tasks set status = $2, version = version + 1, updated_at = $3 ${sets.length ? ',' + sets.join(',') : ''} where id = $1`, [t.id, to, at.toJSDate(), ...Object.values(extra)]);
    await ins('task_state_history', { task_id: t.id, from_status: t.status, to_status: to, actor_id: actor, reason, at: at.toJSDate() });
    Object.assign(t, { status: to }, extra);
  };
  const staff = ['asha', 'vikram', 'priya', 'rahul', 'sara', 'dev', 'meera', 'kabir'];
  const days: DateTime[] = [];
  for (let d = start; d < today; d = d.plus({ days: 1 })) days.push(d);
  const meetingTitles = ['Daily stand-up', 'Client sync', 'Sprint review', 'Vendor call', '1:1', 'Pipeline review'];
  for (const day of days) {
    const date = day.toISODate()!;
    const holiday = date === '2026-10-02';
    for (const k of staff) {
      const sch = k === 'sara' ? (day.weekday <= 4 ? [600, 1080] : null) : day.weekday <= 5 ? [570, 1080] : null;
      if (!sch || holiday || (k === 'rahul' && date === rahulLeave)) continue;
      const pool = tasks.filter((t) => t.spec.owner === k && !['done', 'cancelled', 'in_review'].includes(t.status) && new Date(t.created_at) <= day.set({ hour: 9, minute: 30 }).toJSDate());
      const planned = pool.filter((t) => t.status !== 'blocked').slice(0, Math.min(3, 2 + Math.floor(rnd() * 2)));
      if (!planned.length) continue;
      const plan = await ins('daily_plans', { user_id: U[k], date, created_at: day.set({ hour: 9, minute: 40 }).toJSDate() });
      for (let i = 0; i < planned.length; i++) await ins('daily_plan_items', { plan_id: plan.id, task_id: planned[i].id, position: i + 1, added_at: day.set({ hour: 9, minute: 41 }).toJSDate() });
      // Meeting from calendar (accepted suggestion) + work blocks.
      let cursor = day.startOf('day').plus({ minutes: sch[0] + 10 });
      const meetStart = day.set({ hour: 11, minute: 0 });
      const meetLen = k === 'kabir' || k === 'vikram' ? 90 : 30;
      await ins('time_entries', { user_id: U[k], category: 'meeting', started_at: meetStart.toJSDate(), ended_at: meetStart.plus({ minutes: meetLen }).toJSDate(), source: 'calendar', note: pick(meetingTitles), created_at: meetStart.toJSDate() });
      const coverageTarget = 0.45 + rnd() * 0.5; // realistic partial logging
      const workMinutes = (sch[1] - sch[0] - 60) * coverageTarget - meetLen;
      for (const t of planned) {
        if (t.status === 'planned') await setStatus(t, 'in_progress', cursor, U[k], 'Started');
        let block = Math.max(30, Math.round(workMinutes / planned.length / 15) * 15);
        if (cursor < meetStart && cursor.plus({ minutes: block }) > meetStart && rnd() < 0.7) { block = Math.round(meetStart.diff(cursor, 'minutes').minutes); }
        if (block > 0) await ins('time_entries', { user_id: U[k], task_id: t.id, category: 'task', started_at: cursor.toJSDate(), ended_at: cursor.plus({ minutes: block }).toJSDate(),
          source: rnd() < 0.7 ? 'timer' : 'manual', created_at: cursor.toJSDate() });
        cursor = cursor.plus({ minutes: block + 10 });
        if (cursor >= meetStart && cursor < meetStart.plus({ minutes: meetLen })) cursor = meetStart.plus({ minutes: meetLen + 5 });
        const r = rnd();
        if (r < 0.12 && t.status === 'in_progress') {
          await setStatus(t, 'blocked', cursor, U[k], null);
          const cause = pick(['dependency', 'client', 'requirement', 'access']);
          const waiting = cause === 'client' ? { waiting_on_text: 'Globex IT team' } : cause === 'access' ? { waiting_on_user_id: U.dev } : { waiting_on_user_id: U.priya };
          await ins('blockers', { task_id: t.id, reason: cause === 'client' ? 'Waiting for client to confirm API credentials scope' : cause === 'access' ? 'Need VPN access to staging' :
            cause === 'requirement' ? 'Acceptance criteria unclear for edge cases' : 'Depends on upstream schema change', cause, ...waiting, raised_by: U[k], raised_at: cursor.toJSDate(),
            next_follow_up: rnd() < 0.5 ? day.plus({ days: 1 }).toISODate() : null });
        } else if (r < 0.42 && t.status === 'in_progress') {
          if (t.spec.evidence) await ins('evidence_links', { task_id: t.id, kind: 'link', label: 'Working paper (DEMO link)', url: 'https://example.com/demo/working-paper', added_by: U[k], created_at: cursor.toJSDate() });
          if (t.spec.review) {
            await setStatus(t, 'in_review', cursor, U[k], 'Submitted for review');
            t.reviewDue = day.plus({ days: 1 });
          } else await setStatus(t, 'done', cursor, U[k], null);
        }
      }
      // Occasional timer overlapping the meeting — the report must count it once and flag the conflict.
      if (rnd() < 0.15) await ins('time_entries', { user_id: U[k], task_id: planned[0].id, category: 'task', started_at: meetStart.minus({ minutes: 15 }).toJSDate(),
        ended_at: meetStart.plus({ minutes: 20 }).toJSDate(), source: 'timer', note: 'Forgot to stop timer during meeting', created_at: meetStart.toJSDate() });
      // Recap: most days confirmed; a few left missing to show Insufficient Data.
      if (rnd() < 0.85) {
        const done = planned.filter((t) => ['done', 'in_review'].includes(t.status)).map((t) => t.title);
        const blocked = planned.filter((t) => t.status === 'blocked').map((t) => t.title);
        const summary = done.length ? `Completed/submitted: ${done.join('; ')}.` : `Progressed ${planned.map((t) => t.title).join('; ')}.`;
        const at = day.startOf('day').plus({ minutes: sch[1] - 5 });
        const rev = await ins('daily_reviews', { user_id: U[k], date, status: 'confirmed', summary, blockers_note: blocked.length ? `Blocked: ${blocked.join('; ')}` : '',
          next_steps: `Continue ${planned.find((t) => !['done'].includes(t.status))?.title ?? 'backlog grooming'}`, version: 1, confirmed_at: at.toJSDate(), updated_at: at.toJSDate() });
        await ins('daily_review_versions', { review_id: rev.id, version: 1, snapshot: { summary: rev.summary, blockersNote: rev.blockers_note, nextSteps: rev.next_steps, dayType: 'work' },
          change_reason: 'Confirmed', created_by: U[k], created_at: at.toJSDate() });
        await ins('ux_timings', { user_id: U[k], flow: 'recap', duration_ms: Math.round(35000 + rnd() * 70000), date, created_at: at.toJSDate() });
        await ins('ux_timings', { user_id: U[k], flow: 'plan', duration_ms: Math.round(12000 + rnd() * 30000), date, created_at: day.set({ hour: 9, minute: 41 }).toJSDate() });
        const manager = k === 'rahul' || k === 'sara' ? 'priya' : ['dev', 'meera', 'kabir', 'priya'].includes(k) ? 'asha' : null;
        if (manager && rnd() < 0.5) {
          const rat = at.plus({ hours: 15 });
          await c.query(`update daily_reviews set status = 'manager_reviewed', reviewed_at = $2, reviewed_by = $3 where id = $1`, [rev.id, rat.toJSDate(), U[manager]]);
          await ins('manager_reviews', { subject_user_id: U[k], date, daily_review_id: rev.id, reviewer_id: U[manager], action: 'acknowledge', note: '', created_at: rat.toJSDate() });
        }
      }
    }
    // Reviews happen the next morning
    for (const t of tasks.filter((t) => t.status === 'in_review' && t.reviewDue && t.reviewDue <= day.plus({ days: 1 }))) {
      const at = day.plus({ days: 1 }).set({ hour: 10, minute: 15 });
      if (at >= DateTime.now()) continue;
      const reviewer = U[t.spec.review];
      if (rnd() < 0.75) {
        await ins('task_reviews', { task_id: t.id, reviewer_id: reviewer, decision: 'accepted', note: 'Looks good', created_at: at.toJSDate() });
        await setStatus(t, 'done', at, reviewer, 'Accepted: Looks good');
      } else {
        await ins('task_reviews', { task_id: t.id, reviewer_id: reviewer, decision: 'changes_requested', note: 'Handle the empty-state and add a test', created_at: at.toJSDate() });
        await setStatus(t, 'in_progress', at, reviewer, 'Changes requested: Handle the empty-state and add a test');
        await c.query(`update tasks set reopen_count = reopen_count + 1 where id = $1`, [t.id]);
      }
      t.reviewDue = null;
    }
    // Some blockers resolve after a day
    const open = await q(`select b.id, b.task_id from blockers b where b.tenant_id = $1 and b.resolved_at is null and b.raised_at < $2`, [T, day.toJSDate()]);
    for (const b of open) if (rnd() < 0.6) {
      const t = tasks.find((x) => x.id === b.task_id);
      const at = day.set({ hour: 14 });
      await c.query(`update blockers set resolved_at = $2, resolved_by = $3, resolution = 'Unblocked' where id = $1`, [b.id, at.toJSDate(), t.owner_id]);
      await setStatus(t, 'in_progress', at, t.owner_id, 'Blocker resolved');
    }
  }

  // ---------- Today: plans set, partial time, no recap yet (provisional) ----------
  const todayDate = today.toISODate()!;
  const now = DateTime.now().setZone(TZ);
  for (const k of ['rahul', 'priya', 'dev', 'meera', 'kabir', 'asha']) {
    const pool = tasks.filter((t) => t.spec.owner === k && ['planned', 'in_progress'].includes(t.status) && new Date(t.created_at) <= now.toJSDate());
    if (!pool.length) continue;
    const plan = await ins('daily_plans', { user_id: U[k], date: todayDate });
    for (let i = 0; i < Math.min(3, pool.length); i++) await ins('daily_plan_items', { plan_id: plan.id, task_id: pool[i].id, position: i + 1 });
    const s = today.set({ hour: 9, minute: 45 });
    if (now > s.plus({ minutes: 60 })) await ins('time_entries', { user_id: U[k], task_id: pool[0].id, category: 'task', started_at: s.toJSDate(), ended_at: s.plus({ minutes: 60 }).toJSDate(), source: 'timer' });
  }

  // ---------- Work-tool connections and a confidential reference ----------
  await ins('integration_connections', { kind: 'issues', name: 'Issue tracker webhook', secret_enc: encrypt(newToken(32)), created_by: U.asha, last_sync_at: new Date() });
  const ics = await ins('integration_connections', { kind: 'ics_calendar', name: 'Rahul — work calendar (ICS)', user_id: U.rahul, created_by: U.rahul });
  const hireTask = tasks.find((t) => t.spec.title === 'VP Engineering shortlist');
  if (hireTask) await ins('evidence_links', { task_id: hireTask.id, kind: 'source_ref', label: 'Candidate assessment notes (confidential)', source_module: 'HR drive',
    source_reference: 'HR-FILE-0042', restricted: true, allowed_user_ids: [U.asha], added_by: U.asha });
  const evRow = await ins('integration_events', { connection_id: ics.id, event_id: `demo-standup:${today.set({ hour: 11 }).toUTC().toISO()}`, event_type: 'calendar.event', schema_version: '1.0',
    occurred_at: today.set({ hour: 11 }).toJSDate(), payload: { summary: 'Daily stand-up', start: today.set({ hour: 11 }).toUTC().toISO(), end: today.set({ hour: 11, minute: 30 }).toUTC().toISO() }, status: 'suggested' });
  if (now > today.set({ hour: 11, minute: 30 }))
    await ins('suggestions', { user_id: U.rahul, kind: 'time_entry', dedupe_key: `cal:${evRow.event_id}`, event_ids: [evRow.id], title: 'Daily stand-up',
      data: { started_at: today.set({ hour: 11 }).toUTC().toISO(), ended_at: today.set({ hour: 11, minute: 30 }).toUTC().toISO(), category: 'meeting', source: 'calendar' } });

  await ins('recurring_templates', { title: 'Weekly vendor payment run', owner_id: U.meera, project_id: P.FIN.id, category: 'finance', priority: 'high', estimate_minutes: 90, rule: 'weekly', weekday: 4,
    checklist: JSON.stringify(['Export approved invoices', 'Prepare bank file', 'Attach payment advice']), created_by: U.meera, last_generated_date: today.minus({ days: 1 }).toISODate() });
  await ins('recurring_templates', { title: 'Leadership weekly review', owner_id: U.asha, category: 'admin', priority: 'medium', estimate_minutes: 60, rule: 'weekly', weekday: 5, created_by: U.asha,
    last_generated_date: today.minus({ days: 1 }).toISODate() });
  await ins('notifications', { user_id: U.asha, kind: 'info', title: 'Demo data loaded', body: 'This organization contains fictional DEMO fixtures.', link: '/admin/routine' });
  await audit(c as any, { tenantId: T, actorId: null, action: 'seed.demo', resourceType: 'tenant', resourceId: T, details: { note: 'Fictional demo fixtures' } });
  await c.query('commit');
  await c.end();

  mkdirSync('.data', { recursive: true });
  writeFileSync('.data/demo-credentials.txt', [
    '# DEMO credentials for local development only (fictional users). Regenerated on every `npm run db:seed`.',
    'Organization: demo', `Password for every demo user: ${password}`, '',
    ...people.map((p) => `${p.email}\t${p.title}\troles: ${p.roles.join(',')}`), 'lena@globex.example\tClient (customer portal)', '',
  ].join('\n'), { mode: 0o600 });
  console.log('Demo tenant "demo" seeded with fictional fixtures. Credentials written to .data/demo-credentials.txt');
}
main().catch((e) => { console.error(e); process.exit(1); });
