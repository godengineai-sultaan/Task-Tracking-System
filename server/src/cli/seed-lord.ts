/**
 * DEMO FIXTURES — the LORD AI portfolio organization "AskShiva & GodEngine (DEMO DATA)" (slug `lord`).
 * Provisions the 32-product catalog, assigns companies PROVISIONALLY by the dossier thesis (company_confirmed = false, so the UI asks an
 * administrator to confirm), and adds fictional staff (@lord.example), product memberships and a modest amount of work for a few products.
 * Every person, project and number here is fictional. Re-running replaces the `lord` tenant only.
 * Runs at the end of `npm run db:seed` (own transaction) or alone: `npx tsx server/src/cli/seed-lord.ts`.
 * Credentials are written to .data/lord-credentials.txt (git-ignored), not printed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DateTime } from 'luxon';
import pg from 'pg';
import { config } from '../lib/config.js';
import { hashPassword, newToken } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import type { Db } from '../lib/db.js';
import { loadActor } from '../services/access.js';
import { provisionPortfolio } from '../services/ext/portfolio-provision.js';
import { applyTemplate } from '../services/ext/templates.js';
import { migrate } from './migrate.js';

const TZ = 'Asia/Kolkata';
/** Dossier thesis: GodEngine is the intelligence / reasoning layer; AskShiva the execution layer. Provisional until an admin confirms. */
export const GODENGINE_PRODUCTS = ['GODENGINE', 'WORLD_360', 'STARTUP_INTEL', 'WORLD_FINANCE', 'VIDYA_AI', 'FALCON'];

const PEOPLE = [
  { key: 'founder', name: 'Kavya Menon', title: 'Founder & Group CEO (demo)', dept: 'Leadership', founder: true,
    roles: ['member', 'system_admin', 'routine_admin', 'leadership', 'cost_viewer', 'manager'] },
  { key: 'rohan', name: 'Rohan Desai', title: 'Co-founder, Intelligence (demo)', dept: 'Leadership', founder: true, roles: ['member', 'leadership'] },
  { key: 'nisha', name: 'Nisha Bhat', title: 'Head of Education Products', dept: 'Education', roles: ['member', 'manager'] },
  { key: 'arjun', name: 'Arjun Pillai', title: 'ML Engineer', dept: 'Intelligence', roles: ['member'] },
  { key: 'meghna', name: 'Meghna Rao', title: 'Curriculum Lead', dept: 'Education', roles: ['member'] },
  { key: 'farhan', name: 'Farhan Qureshi', title: 'Full-stack Engineer', dept: 'Education', roles: ['member'] },
  { key: 'lakshmi', name: 'Lakshmi Iyer', title: 'Product Manager, Business OS', dept: 'Business OS', roles: ['member'] },
  { key: 'vivek', name: 'Vivek Sharma', title: 'Backend Engineer', dept: 'Business OS', roles: ['member'] },
  { key: 'zoya', name: 'Zoya Khan', title: 'Growth Lead', dept: 'Growth', roles: ['member'] },
  { key: 'tenzin', name: 'Tenzin Dorje', title: 'Data Analyst', dept: 'Intelligence', roles: ['member'] },
  { key: 'ananya', name: 'Ananya Gupta', title: 'Research Lead, Markets', dept: 'Intelligence', roles: ['member'] },
  { key: 'kiran', name: 'Kiran Joshi', title: 'Platform Engineer', dept: 'Platform', roles: ['member'] },
  { key: 'sameer', name: 'Sameer Ali', title: 'Enterprise Sales', dept: 'Growth', roles: ['member'] },
  { key: 'divya', name: 'Divya Nair', title: 'Finance & Operations', dept: 'Finance & Operations', roles: ['member', 'cost_viewer'] },
];
/** product key -> [user key, role][] */
const MEMBERS: Record<string, [string, 'lead' | 'member' | 'viewer'][]> = {
  GODENGINE: [['rohan', 'lead'], ['arjun', 'member'], ['sameer', 'viewer']],
  WORLD_360: [['rohan', 'lead'], ['ananya', 'member']],
  VIDYA_AI: [['nisha', 'lead'], ['meghna', 'member'], ['arjun', 'member'], ['sameer', 'member']],
  VIDYA_COPILOT: [['nisha', 'lead'], ['farhan', 'member']],
  EXAM_ENGINE: [['nisha', 'lead'], ['meghna', 'member']],
  CAMPUS_ONE: [['nisha', 'lead'], ['farhan', 'member']],
  HRMS: [['lakshmi', 'lead'], ['vivek', 'member']],
  UNIFLOW: [['lakshmi', 'lead'], ['vivek', 'member']],
  BUSINESS_OS: [['lakshmi', 'lead']],
  CONTENT_365: [['zoya', 'lead']],
  SOCIAL_STUDIO: [['zoya', 'lead']],
  SOCIAL_MANAGER: [['zoya', 'lead']],
  WORLD_FINANCE: [['ananya', 'lead'], ['tenzin', 'member']],
  STARTUP_INTEL: [['ananya', 'lead'], ['tenzin', 'member']],
  SHARED_RUNTIME: [['kiran', 'lead']],
  AI_HARDWARE: [['kiran', 'lead']],
  SERVER_APPS: [['kiran', 'member']],
  JEWELX: [['sameer', 'lead']],
  ASKSHIVA: [['founder', 'lead']],
};
/** Platform products every staff member can see. */
const COMPANY_VISIBLE = ['SHARED_RUNTIME', 'BUSINESS_OS'];

type TaskSpec = { title: string; owner: string; status: string; cat: string; est: number; due: number; review?: string; blocker?: string; logged?: number };
const PROJECTS: { key: string; name: string; product: string | null; owner: string; outcome: string; tasks: TaskSpec[] }[] = [
  { key: 'VIDCORPUS', name: 'Corpus release 2026.10', product: 'VIDYA_AI', owner: 'meghna', outcome: 'Revised Maharashtra Board science content live in pilot schools, offline bundles included', tasks: [
    { title: 'Ingest Maharashtra Board Class 9 science revisions', owner: 'meghna', status: 'in_progress', cat: 'research', est: 240, due: 3, logged: 150 },
    { title: 'Hallucination evaluation on the revised corpus', owner: 'arjun', status: 'planned', cat: 'delivery', est: 300, due: 6, review: 'meghna' },
    { title: 'Clear licensing for new reference texts', owner: 'meghna', status: 'blocked', cat: 'admin', est: 120, due: 1, blocker: 'Waiting for the publisher to confirm the licence scope' },
    { title: 'Package the offline update bundle', owner: 'arjun', status: 'planned', cat: 'delivery', est: 180, due: 9 },
  ] },
  { key: 'GEREASON', name: 'Reasoning API v2', product: 'GODENGINE', owner: 'rohan', outcome: 'Multi-step reasoning API ready for two design partners', tasks: [
    { title: 'Latency budget for multi-step reasoning', owner: 'arjun', status: 'in_progress', cat: 'research', est: 180, due: 2, logged: 120 },
    { title: 'Evaluation harness for tool-use traces', owner: 'rohan', status: 'done', cat: 'delivery', est: 240, due: -2, logged: 90 },
    { title: 'Rate-limit design for the partner tier', owner: 'rohan', status: 'planned', cat: 'delivery', est: 120, due: 7 },
  ] },
  { key: 'WFTFEEDS', name: 'Market data feeds', product: 'WORLD_FINANCE', owner: 'ananya', outcome: 'Reliable end-of-day and intraday feeds with stale-data alerts', tasks: [
    { title: 'Reconcile end-of-day exchange feed gaps', owner: 'tenzin', status: 'in_progress', cat: 'research', est: 180, due: -1, logged: 135 },
    { title: 'Data licensing review for index constituents', owner: 'ananya', status: 'in_review', cat: 'admin', est: 90, due: 2, review: 'rohan' },
    { title: 'Alerting for stale tickers', owner: 'tenzin', status: 'planned', cat: 'delivery', est: 150, due: 8 },
  ] },
  { key: 'HRPAYROLL', name: 'Payroll module GA', product: 'HRMS', owner: 'lakshmi', outcome: 'Payroll generally available for the first three customers', tasks: [
    { title: 'Statutory deductions rules engine (PF / ESI)', owner: 'vivek', status: 'in_progress', cat: 'delivery', est: 360, due: 4, logged: 180 },
    { title: 'Payslip PDF template review', owner: 'lakshmi', status: 'planned', cat: 'delivery', est: 60, due: 5 },
    { title: 'Pilot customer data migration', owner: 'vivek', status: 'blocked', cat: 'delivery', est: 240, due: 2, blocker: 'Customer has not shared the employee master export yet' },
  ] },
  { key: 'C365LAUNCH', name: 'Creator onboarding launch', product: 'CONTENT_365', owner: 'zoya', outcome: 'New creators publish their first post within a day of signing up', tasks: [
    { title: 'Onboarding email sequence', owner: 'zoya', status: 'done', cat: 'sales', est: 120, due: -3, logged: 60 },
    { title: 'Template gallery: festive season set', owner: 'zoya', status: 'in_progress', cat: 'delivery', est: 240, due: 3, logged: 90 },
    { title: 'Activation funnel dashboard', owner: 'zoya', status: 'planned', cat: 'research', est: 120, due: 10 },
  ] },
  { key: 'RUNTIME', name: 'Inference gateway hardening', product: 'SHARED_RUNTIME', owner: 'kiran', outcome: 'Shared runtime survives a node loss without user-visible errors', tasks: [
    { title: 'GPU node autoscaling policy', owner: 'kiran', status: 'in_progress', cat: 'operations', est: 240, due: 2, logged: 120 },
    { title: 'Per-product cost attribution tags', owner: 'kiran', status: 'planned', cat: 'operations', est: 180, due: 6 },
  ] },
  { key: 'OPSHQ', name: 'Group operations', product: null, owner: 'divya', outcome: 'Statutory and office work for both companies stays on schedule', tasks: [
    { title: 'Quarterly GST filing for both entities', owner: 'divya', status: 'planned', cat: 'finance', est: 240, due: 8 },
    { title: 'Renew the office lease', owner: 'founder', status: 'planned', cat: 'operations', est: 90, due: 12 },
  ] },
];

export async function seedLord(opts: { password?: string } = {}) {
  const c = new pg.Client({ connectionString: config.migrationDatabaseUrl });
  await c.connect();
  const db = c as unknown as Db;
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p).then((r) => r.rows);
  const q1 = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];
  const password = opts.password || process.env.SEED_PASSWORD || newToken(12);
  try {
    await c.query('begin');
    await c.query(`set local app.audit_purge = 'on'`);
    await c.query(`delete from tenants where slug = 'lord'`);
    const hash = await hashPassword(password);
    const today = DateTime.now().setZone(TZ).startOf('day');
    const workday = (n: number) => { let d = today; let k = 0; while (k < n) { d = d.minus({ days: 1 }); if (d.weekday <= 5) k++; } return d; };

    const tenant = await q1(`insert into tenants (slug, name, timezone, plan, seat_limit, modules, settings, onboarded_at, contact_email)
      values ('lord','AskShiva & GodEngine (DEMO DATA)',$1,'enterprise',100, array['tasks','analytics','admin_routine','integrations'],$2, now(), 'ops@lord.example') returning *`,
    [TZ, { founders_visible_to_routine_admin: true, include_meetings_in_work_policy: true, coverage_threshold: 0.5, retention_days: 730, ai_enabled: false,
      voice_capture_enabled: false, evidence_required_categories: [], review_required_categories: [] }]);
    const T = tenant.id;
    const ins = (table: string, row: Record<string, unknown>) => {
      const keys = Object.keys(row);
      return q1(`insert into ${table} (tenant_id, ${keys.join(',')}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) returning *`, [T, ...keys.map((k) => row[k])]);
    };

    const dept: Record<string, string> = {};
    for (const n of [...new Set(PEOPLE.map((p) => p.dept))]) dept[n] = (await ins('departments', { name: n })).id;
    const U: Record<string, string> = {};
    for (const p of PEOPLE) U[p.key] = (await ins('users', { email: `${p.key}@lord.example`, name: p.name, password_hash: hash, roles: p.roles, title: p.title,
      department_id: dept[p.dept], is_founder: !!p.founder, last_login_at: new Date() })).id;
    const team = await ins('teams', { name: 'Education products', manager_id: U.nisha, department_id: dept.Education });
    for (const k of ['arjun', 'meghna', 'farhan']) await ins('team_members', { team_id: team.id, user_id: U[k] });
    for (let wd = 1; wd <= 5; wd++) await ins('work_schedules', { weekday: wd, start_minute: 570, end_minute: 1080, break_minutes: 60 });

    // Catalog: 2 companies, 32 products, KPI definitions and 96 playbooks.
    await provisionPortfolio(db, T, null);
    const companies = Object.fromEntries((await q(`select code, id from companies where tenant_id = $1`, [T])).map((r) => [r.code, r.id]));
    await c.query(`update products set company_id = case when key = any($2::text[]) then $3::uuid else $4::uuid end, company_confirmed = false where tenant_id = $1`,
      [T, GODENGINE_PRODUCTS, companies.GOD, companies.ASK]);
    await c.query(`update products set visibility = 'company' where tenant_id = $1 and key = any($2::text[])`, [T, COMPANY_VISIBLE]);
    const P = Object.fromEntries((await q(`select key, id from products where tenant_id = $1`, [T])).map((r) => [r.key, r.id]));
    for (const [product, members] of Object.entries(MEMBERS))
      for (const [user, role] of members) await ins('product_members', { product_id: P[product], user_id: U[user], role, added_by: U.founder });

    // Work: one or two projects for a handful of products, plus company-wide operations.
    let n = 0;
    const tasksByProject: Record<string, any[]> = {};
    for (const pr of PROJECTS) {
      const project = await ins('projects', { key: pr.key, name: pr.name, product_id: pr.product ? P[pr.product] : null, owner_id: U[pr.owner], visibility: 'company',
        business_outcome: pr.outcome, start_date: workday(15).toISODate(), target_date: today.plus({ days: 45 }).toISODate() });
      await ins('project_members', { project_id: project.id, user_id: U[pr.owner] });
      tasksByProject[pr.key] = [];
      for (const s of pr.tasks) {
        const created = workday(8 + (n++ % 4)).set({ hour: 10 });
        const started = s.status !== 'planned' ? workday(3).set({ hour: 11 }) : null;
        const done = s.status === 'done' ? workday(1).set({ hour: 16 }) : null;
        const t = await ins('tasks', { project_id: project.id, title: s.title, owner_id: U[s.owner], created_by: U[pr.owner], status: s.status, priority: s.due <= 2 ? 'high' : 'medium',
          category: s.cat, due_date: today.plus({ days: s.due }).toISODate(), estimate_minutes: s.est, requires_review: !!s.review, reviewer_id: s.review ? U[s.review] : null,
          created_at: created.toJSDate(), updated_at: (done ?? started ?? created).toJSDate(), started_at: started?.toJSDate() ?? null,
          done_at: done?.toJSDate() ?? null, accepted_at: done?.toJSDate() ?? null, sort_order: created.toSeconds(), source_type: 'manual' });
        await ins('task_state_history', { task_id: t.id, from_status: null, to_status: 'planned', actor_id: U[pr.owner], reason: 'Created (DEMO fixture)', at: created.toJSDate() });
        if (started) await ins('task_state_history', { task_id: t.id, from_status: 'planned', to_status: s.status === 'done' ? 'in_progress' : s.status, actor_id: U[s.owner], at: started.toJSDate() });
        if (done) await ins('task_state_history', { task_id: t.id, from_status: 'in_progress', to_status: 'done', actor_id: U[s.owner], at: done.toJSDate() });
        if (s.blocker) await ins('blockers', { task_id: t.id, reason: s.blocker, cause: 'client', waiting_on_text: 'External party', raised_by: U[s.owner], raised_at: started!.toJSDate(),
          next_follow_up: today.plus({ days: 1 }).toISODate() });
        // Time evidence over the last working days (the trigger files it under the task's product).
        if (s.logged) for (let d = 1, left = s.logged; left > 0 && d <= 3; d++) {
          const block = Math.min(left, 60 + 15 * (d % 2));
          const at = workday(d).set({ hour: 10 + d, minute: 0 });
          await ins('time_entries', { user_id: U[s.owner], task_id: t.id, category: 'task', started_at: at.toJSDate(), ended_at: at.plus({ minutes: block }).toJSDate(),
            source: d === 1 ? 'timer' : 'manual', created_at: at.toJSDate() });
          left -= block;
        }
        tasksByProject[pr.key].push(t);
      }
    }
    // Product work without a project: it still belongs to its product.
    await ins('tasks', { product_id: P.GODENGINE, title: 'Investor demo script for the reasoning layer', owner_id: U.rohan, created_by: U.rohan, status: 'planned', priority: 'medium',
      category: 'sales', due_date: today.plus({ days: 4 }).toISODate(), estimate_minutes: 90, source_type: 'manual' });
    await ins('task_collaborators', { task_id: tasksByProject.VIDCORPUS[1].id, user_id: U.meghna });
    await ins('checklist_items', { task_id: tasksByProject.VIDCORPUS[0].id, text: 'Physics chapters', position: 0, done: true });
    await ins('checklist_items', { task_id: tasksByProject.VIDCORPUS[0].id, text: 'Chemistry chapters', position: 1, done: false });
    await ins('comments', { task_id: tasksByProject.HRPAYROLL[2].id, author_id: U.lakshmi, body: 'Followed up with the pilot customer; export promised by Friday. (DEMO)' });

    // A catalog playbook applied as real work: Vidya AI's "School pilot to deployment" for a fictional Pune school cluster.
    const pilot = await ins('projects', { key: 'VIDPILOT', name: 'Pune schools pilot', product_id: P.VIDYA_AI, owner_id: U.nisha, visibility: 'company',
      business_outcome: 'Two pilot schools move to full deployment', start_date: workday(6).toISODate(), target_date: today.plus({ days: 60 }).toISODate() });
    await ins('project_members', { project_id: pilot.id, user_id: U.nisha });
    const playbook = await q1(`select * from task_templates where tenant_id = $1 and starter_key = 'catalog:VIDYA_AI:1'`, [T]);
    const founder = await loadActor(db, T, U.founder);
    if (playbook && founder) await applyTemplate(db, founder, playbook, { startDate: workday(2).toISODate()!, projectId: pilot.id, defaultOwnerId: U.nisha,
      assignments: { '1': U.sameer, '2': U.meghna, '3': U.arjun }, applyKey: 'demo-lord-vidya-pilot' });

    await ins('notifications', { user_id: U.founder, kind: 'info', title: 'Demo portfolio loaded', body: 'Company assignments are provisional. Confirm them in Administration > Portfolio.',
      link: '/admin?tab=portfolio' });
    await audit(db, { tenantId: T, actorId: null, action: 'seed.lord', resourceType: 'tenant', resourceId: T, details: { note: 'Fictional LORD portfolio demo fixtures' } });
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }

  mkdirSync('.data', { recursive: true });
  writeFileSync('.data/lord-credentials.txt', [
    '# DEMO credentials for local development only (fictional users). Regenerated on every seed.',
    'Organization: lord', `Password for every demo user: ${password}`, '',
    ...PEOPLE.map((p) => `${p.key}@lord.example\t${p.title}\troles: ${p.roles.join(',')}`), '',
  ].join('\n'), { mode: 0o600 });
  return { password };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().then(() => seedLord()).then(() => console.log('Demo tenant "lord" seeded with fictional fixtures. Credentials written to .data/lord-credentials.txt'))
    .catch((e) => { console.error(e); process.exit(1); });
}
