import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '../../app.js';
import { many, one, type Db } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { type Actor, loadVisibleTask, requireStaff, taskVisibility } from '../../services/access.js';
import { PRESETS, RuleSchema, assertCanCreate, canCreateScope, canManageRule, dryRun, validateRule } from '../../services/ext/automation.js';

const uuid = z.string().uuid();
const RULE_COLUMNS = `r.id, r.name, r.description, r.enabled, r.trigger, r.conditions, r.actions, r.scope, r.owner_id, r.created_by, r.preset, r.version, r.created_at, r.updated_at`;

async function loadRule(db: Db, id: string) {
  const r = await one(db, `select * from automation_rules where id = $1 and archived_at is null`, [id]);
  if (!r) throw notFound('Rule not found');
  return r;
}
function assertManage(a: Actor, rule: any) {
  if (!canManageRule(a, rule)) throw forbidden(rule.scope === 'company' ? 'Only system admins can change company-wide rules' : 'Only the rule owner or a system admin can change this team rule');
}
const authorityFor = (a: Actor, rule: { scope: string; owner_id: string }) => rule.scope === 'company' ? 'system_admin' : rule.owner_id === a.id ? 'team_manager' : 'system_admin';

/** Routes for the 'automation' feature area: no-code rules, run log and dry runs. */
export default async function (app: FastifyInstance) {
  app.get('/api/automations', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const rules = await many(db, `select ${RULE_COLUMNS}, o.name owner_name, c.name created_by_name,
        lr.status last_status, lr.created_at last_run_at, lr.message last_message,
        coalesce(s.success, 0) success_7d, coalesce(s.skipped, 0) skipped_7d, coalesce(s.failed, 0) failed_7d
      from automation_rules r join users o on o.id = r.owner_id left join users c on c.id = r.created_by
      left join lateral (select status, created_at, message from automation_runs x where x.rule_id = r.id order by x.created_at desc limit 1) lr on true
      left join lateral (select count(*) filter (where status = 'success')::int success, count(*) filter (where status = 'skipped')::int skipped,
        count(*) filter (where status = 'failed')::int failed from automation_runs x where x.rule_id = r.id and x.created_at > now() - interval '7 days') s on true
      where r.archived_at is null order by r.scope, r.created_at`);
    return {
      rules: rules.map((r) => ({ ...r, can_edit: canManageRule(a, r) })),
      permissions: { company: canCreateScope(a, 'company'), team: canCreateScope(a, 'team') },
      presets: PRESETS,
    };
  }));

  app.post('/api/automations', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const b = RuleSchema.parse(req.body);
    assertCanCreate(a, b.scope);
    const v = await validateRule(db, b, a.id);
    const row = await one(db, `insert into automation_rules (tenant_id, name, description, enabled, trigger, conditions, actions, scope, owner_id, created_by, updated_by, preset)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9,$10) returning *`,
      [a.tenantId, b.name, b.description ?? '', b.enabled ?? true, JSON.stringify(v.trigger), JSON.stringify(v.conditions), JSON.stringify(v.actions), b.scope, a.id, b.preset ?? null]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'automation_rule.create', resourceType: 'automation_rule', resourceId: row.id, resourceVersion: 1,
      correlationId: req.id, authority: authorityFor(a, row), details: { name: row.name, scope: row.scope, trigger: v.trigger.type, actions: v.actions.map((x) => x.type), enabled: row.enabled } });
    return row;
  }));

  app.put('/api/automations/:id', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const rule = await loadRule(db, (req.params as any).id);
    assertManage(a, rule);
    const b = RuleSchema.extend({ version: z.number().int() }).parse(req.body);
    if (b.scope !== rule.scope) throw badRequest('A rule\'s scope cannot change; create a new rule instead');
    if (b.version !== rule.version) throw conflict('This rule was changed by someone else. Reload to see the latest version.', { currentVersion: rule.version });
    const v = await validateRule(db, b, rule.owner_id);
    const row = await one(db, `update automation_rules set name = $3, description = $4, enabled = $5, trigger = $6, conditions = $7, actions = $8, updated_by = $9,
        version = version + 1, updated_at = now() where id = $1 and version = $2 returning *`,
      [rule.id, b.version, b.name, b.description ?? '', b.enabled ?? rule.enabled, JSON.stringify(v.trigger), JSON.stringify(v.conditions), JSON.stringify(v.actions), a.id]);
    if (!row) throw conflict('This rule was changed by someone else. Reload to see the latest version.');
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'automation_rule.update', resourceType: 'automation_rule', resourceId: rule.id, resourceVersion: row.version,
      correlationId: req.id, authority: authorityFor(a, rule), details: { name: row.name, trigger: v.trigger.type, actions: v.actions.map((x) => x.type), enabled: row.enabled } });
    return row;
  }));

  app.patch('/api/automations/:id/enabled', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const rule = await loadRule(db, (req.params as any).id);
    assertManage(a, rule);
    const b = z.object({ enabled: z.boolean(), version: z.number().int() }).parse(req.body);
    const row = await one(db, `update automation_rules set enabled = $3, updated_by = $4, version = version + 1, updated_at = now() where id = $1 and version = $2 returning *`,
      [rule.id, b.version, b.enabled, a.id]);
    if (!row) throw conflict('This rule was changed by someone else. Reload to see the latest version.', { currentVersion: rule.version });
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: b.enabled ? 'automation_rule.enable' : 'automation_rule.disable', resourceType: 'automation_rule',
      resourceId: rule.id, resourceVersion: row.version, correlationId: req.id, authority: authorityFor(a, rule) });
    return row;
  }));

  // Archive: the rule stops running; its run history and audit trail stay.
  app.delete('/api/automations/:id', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const rule = await loadRule(db, (req.params as any).id);
    assertManage(a, rule);
    await db.query(`update automation_rules set archived_at = now(), enabled = false, updated_by = $2, version = version + 1, updated_at = now() where id = $1`, [rule.id, a.id]);
    await audit(db, { tenantId: a.tenantId, actorId: a.id, action: 'automation_rule.archive', resourceType: 'automation_rule', resourceId: rule.id,
      resourceVersion: rule.version + 1, correlationId: req.id, authority: authorityFor(a, rule), details: { name: rule.name } });
    return { ok: true };
  }));

  // Run log. Task titles and what the rule did (recipients, follow-ups, errors) are shown only for tasks the viewer can already see.
  app.get('/api/automations/runs', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const q = z.object({ ruleId: uuid.optional(), status: z.enum(['success', 'skipped', 'failed']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const [vis, params] = taskVisibility(a, 1);
    const vals: unknown[] = [...params];
    const where = ['true'];
    if (q.ruleId) { vals.push(q.ruleId); where.push(`x.rule_id = $${vals.length}`); }
    if (q.status) { vals.push(q.status); where.push(`x.status = $${vals.length}`); }
    vals.push(q.limit);
    return many(db, `select x.id, x.rule_id, x.rule_version, vt.id task_id, x.trigger, x.status, x.depth, x.created_at,
        case when vt.id is not null then x.message end message, case when vt.id is not null then x.results else '[]'::jsonb end results,
        r.name rule_name, r.scope rule_scope, vt.title task_title, vt.number task_number, (vt.id is not null) task_visible
      from automation_runs x join automation_rules r on r.id = x.rule_id
      left join lateral (select t.id, t.title, t.number from tasks t left join projects p on p.id = t.project_id where t.id = x.task_id and ${vis}) vt on true
      where ${where.join(' and ')} order by x.created_at desc, x.id limit $${vals.length}`, vals);
  }));

  // Dry run: what would this rule (saved or draft) do to this task right now? Reads only.
  app.post('/api/automations/test', async (req) => tx(req, async (db, a) => {
    requireStaff(a);
    const b = z.object({ taskId: uuid, ruleId: uuid.optional(), rule: RuleSchema.optional() }).parse(req.body);
    if (!b.rule && !b.ruleId) throw badRequest('Provide a rule to test');
    const saved = b.ruleId ? await loadRule(db, b.ruleId) : null;
    let rule: any = saved;
    if (b.rule) {
      if (saved) { assertManage(a, saved); if (b.rule.scope !== saved.scope) throw badRequest('A rule\'s scope cannot change'); }
      else assertCanCreate(a, b.rule.scope);
      const ownerId = saved?.owner_id ?? a.id;
      const v = await validateRule(db, b.rule, ownerId);
      rule = { id: saved?.id ?? 'draft', tenant_id: a.tenantId, version: saved?.version ?? 0, name: b.rule.name, enabled: b.rule.enabled ?? true,
        scope: b.rule.scope, owner_id: ownerId, ...v };
    }
    await loadVisibleTask(db, a, b.taskId);
    return dryRun(db, rule, b.taskId);
  }));
}
