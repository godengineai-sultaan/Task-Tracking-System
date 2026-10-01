import type { Db } from '../../lib/db.js';
import { loadActor } from '../../services/access.js';
import { applyTemplate, createTemplate, ensureStarterTemplates, templateSchema, updateSchema, updateTemplate } from '../../services/ext/templates.js';
import type { SeedCtx } from './types.js';

/** Fictional DEMO fixtures for the 'templates' feature area. */
export default async function seed(ctx: SeedCtx) {
  const db = ctx.c as unknown as Db;
  const { T, U, P, M } = ctx;
  await ensureStarterTemplates(db, T, null);
  // The seed client is not serialized: load actors one at a time.
  const priya = await loadActor(db, T, U.priya); const dev = await loadActor(db, T, U.dev); const asha = await loadActor(db, T, U.asha);

  // A team-made company playbook (with one revision) and a personal private one.
  const uatInput = templateSchema.parse({
    name: 'Client UAT round', category: 'client', visibility: 'company',
    description: 'Run a user-acceptance round with a client: test plan, guided sessions, triage and a written sign-off. (DEMO DATA)',
    items: [
      { title: 'Write the UAT test plan', category: 'delivery', priority: 'high', estimateMinutes: 120, dueOffsetDays: 0, ownerHint: 'Engineering manager',
        checklist: ['Scenarios per feature', 'Test accounts', 'Entry and exit criteria'] },
      { title: 'Prepare the UAT environment and test data', category: 'delivery', priority: 'high', estimateMinutes: 180, dueOffsetDays: 2, ownerHint: 'Engineer', dependsOn: [1] },
      { title: 'Run guided UAT sessions with the client', category: 'delivery', priority: 'high', estimateMinutes: 240, dueOffsetDays: 4, ownerHint: 'Engineering manager', dependsOn: [2] },
      { title: 'Triage UAT findings', category: 'delivery', priority: 'high', estimateMinutes: 120, dueOffsetDays: 5, ownerHint: 'Engineer', dependsOn: [3] },
      { title: 'Fix must-have UAT findings', category: 'delivery', priority: 'urgent', estimateMinutes: 480, dueOffsetDays: 8, ownerHint: 'Engineer', requiresReview: true, dependsOn: [4] },
    ],
  });
  const uat = await createTemplate(db, priya!, uatInput);
  await updateTemplate(db, priya!, uat, updateSchema.parse({
    ...uatInput, version: 1, changeNote: 'Added the written sign-off step after the Globex beta',
    items: [...uatInput.items, { title: 'Collect written client sign-off', category: 'delivery', priority: 'high', estimateMinutes: 30, dueOffsetDays: 9,
      ownerHint: 'Engineering manager', requiresEvidence: true, dependsOn: [5] }],
  }));

  await createTemplate(db, dev!, templateSchema.parse({
    name: 'Quarterly office supplies restock', category: 'procurement', visibility: 'private',
    description: 'My checklist for the quarterly stationery, pantry and printer supplies order. (DEMO DATA)',
    items: [
      { title: 'Count stock and list shortages', category: 'operations', estimateMinutes: 45, dueOffsetDays: 0, checklist: ['Stationery', 'Pantry', 'Printer toner and paper'] },
      { title: 'Place the supplies order', category: 'operations', estimateMinutes: 30, dueOffsetDays: 1, dependsOn: [1] },
      { title: 'Check the delivery against the order', category: 'operations', estimateMinutes: 20, dueOffsetDays: 5, dependsOn: [2] },
    ],
  }));

  // The onboarding starter applied for a fictional October joiner in Operations, starting next Monday.
  const onboarding = await ctx.q1(`select * from task_templates where tenant_id = $1 and starter_key = 'onboarding'`, [T]);
  const monday = ctx.today.plus({ days: 8 - ctx.today.weekday }).toISODate()!;
  await applyTemplate(db, asha!, onboarding, {
    startDate: monday, projectId: P.OPS.id, milestoneId: M.ops1.id, defaultOwnerId: U.dev, assignments: { '4': U.meera },
    applyKey: 'demo-onboarding-october-joiner',
  });
}
