/**
 * Generic starter playbooks provisioned once per tenant on first use. Offsets are working days
 * after the chosen start date; owner hints name a role, never a person.
 */
export interface StarterItem {
  title: string; description?: string; category: string; priority: string; estimateMinutes: number | null; dueOffsetDays: number | null;
  ownerHint?: string; checklist?: string[]; requiresReview?: boolean; requiresEvidence?: boolean; dependsOn?: number[];
}
export interface Starter { key: string; name: string; description: string; category: string; items: StarterItem[] }

export const STARTERS: Starter[] = [
  {
    key: 'onboarding', name: 'New employee onboarding', category: 'people',
    description: 'From accepted offer to the end of the first two weeks: equipment, accounts, payroll, orientation and early goals.',
    items: [
      { title: 'Send welcome email and first-day agenda', category: 'admin', priority: 'high', estimateMinutes: 30, dueOffsetDays: 0, ownerHint: 'Hiring manager',
        checklist: ['Start time and location', 'First-week schedule', 'Who to ask for help'] },
      { title: 'Order laptop and accessories', category: 'operations', priority: 'high', estimateMinutes: 45, dueOffsetDays: 0, ownerHint: 'Operations',
        checklist: ['Confirm specification with the hiring manager', 'Raise the purchase order', 'Track the delivery date'] },
      { title: 'Create work accounts', description: 'Email, calendar, team chat, task tracker and shared drives.', category: 'operations', priority: 'high',
        estimateMinutes: 60, dueOffsetDays: 2, ownerHint: 'IT / Operations', checklist: ['Email and calendar', 'Team chat', 'Task tracker access', 'Shared drive groups'] },
      { title: 'Add to payroll and benefits', category: 'finance', priority: 'medium', estimateMinutes: 45, dueOffsetDays: 3, ownerHint: 'Finance',
        requiresEvidence: true, checklist: ['Bank details received', 'Tax declarations filed', 'Benefits enrolment sent'] },
      { title: 'Assign an onboarding buddy', category: 'admin', priority: 'medium', estimateMinutes: 15, dueOffsetDays: 4, ownerHint: 'Hiring manager' },
      { title: 'Day-one setup and orientation', category: 'admin', priority: 'high', estimateMinutes: 90, dueOffsetDays: 5, ownerHint: 'Hiring manager',
        dependsOn: [2, 3, 5], checklist: ['Hand over laptop', 'Walk through the tools', 'Introduce the buddy and the team'] },
      { title: 'Agree 30-day goals', category: 'admin', priority: 'medium', estimateMinutes: 60, dueOffsetDays: 7, ownerHint: 'Hiring manager', dependsOn: [6] },
      { title: 'Two-week check-in', category: 'admin', priority: 'medium', estimateMinutes: 30, dueOffsetDays: 10, ownerHint: 'Hiring manager', dependsOn: [7],
        checklist: ['What is going well', 'What is still unclear', 'Access or equipment still missing'] },
    ],
  },
  {
    key: 'month_end_close', name: 'Month-end close', category: 'finance',
    description: 'Cut-off, reconciliations, accruals and a reviewed set of management accounts.',
    items: [
      { title: 'Send the cut-off reminder to all teams', category: 'finance', priority: 'medium', estimateMinutes: 15, dueOffsetDays: 0, ownerHint: 'Finance lead' },
      { title: 'Collect outstanding invoices and expense claims', category: 'finance', priority: 'high', estimateMinutes: 120, dueOffsetDays: 1, ownerHint: 'Accountant',
        dependsOn: [1], checklist: ['Vendor invoices', 'Employee expense claims', 'Card statements'] },
      { title: 'Bank reconciliation', category: 'finance', priority: 'high', estimateMinutes: 180, dueOffsetDays: 2, ownerHint: 'Accountant', requiresEvidence: true,
        checklist: ['Operating account', 'Payroll account', 'Unmatched items listed with owners'] },
      { title: 'Post accruals and prepayments', category: 'finance', priority: 'high', estimateMinutes: 120, dueOffsetDays: 3, ownerHint: 'Accountant',
        requiresReview: true, dependsOn: [2] },
      { title: 'Review receivables and payables ageing', category: 'finance', priority: 'medium', estimateMinutes: 90, dueOffsetDays: 3, ownerHint: 'Accountant', dependsOn: [2] },
      { title: 'Draft management accounts', category: 'finance', priority: 'high', estimateMinutes: 240, dueOffsetDays: 5, ownerHint: 'Finance lead',
        requiresReview: true, dependsOn: [3, 4, 5] },
      { title: 'Close review and sign-off', category: 'finance', priority: 'high', estimateMinutes: 60, dueOffsetDays: 6, ownerHint: 'Finance controller',
        requiresReview: true, requiresEvidence: true, dependsOn: [6] },
    ],
  },
  {
    key: 'vendor_purchase', name: 'Vendor purchase', category: 'procurement',
    description: 'A documented purchase: requirement, quotes, recommendation, purchase order, delivery check and invoice match.',
    items: [
      { title: 'Write the requirement and budget note', category: 'operations', priority: 'medium', estimateMinutes: 45, dueOffsetDays: 0, ownerHint: 'Requester',
        checklist: ['What and why', 'Quantity', 'Budget line', 'Needed-by date'] },
      { title: 'Collect three quotes', category: 'operations', priority: 'medium', estimateMinutes: 120, dueOffsetDays: 3, ownerHint: 'Operations',
        requiresEvidence: true, dependsOn: [1] },
      { title: 'Compare quotes and recommend a vendor', category: 'operations', priority: 'medium', estimateMinutes: 60, dueOffsetDays: 5, ownerHint: 'Operations',
        requiresReview: true, dependsOn: [2] },
      { title: 'Raise the purchase order', category: 'finance', priority: 'high', estimateMinutes: 30, dueOffsetDays: 6, ownerHint: 'Finance', requiresEvidence: true, dependsOn: [3] },
      { title: 'Confirm delivery and inspect goods', category: 'operations', priority: 'medium', estimateMinutes: 30, dueOffsetDays: 12, ownerHint: 'Operations', dependsOn: [4],
        checklist: ['Quantity matches the order', 'No damage', 'Warranty documents filed'] },
      { title: 'Match the invoice to the order and schedule payment', category: 'finance', priority: 'medium', estimateMinutes: 30, dueOffsetDays: 14, ownerHint: 'Finance',
        requiresEvidence: true, dependsOn: [5] },
    ],
  },
  {
    key: 'client_kickoff', name: 'Client project kickoff', category: 'client',
    description: 'Handover, kickoff meeting, agreed scope and a milestone plan in the first week and a half.',
    items: [
      { title: 'Internal handover from sales', category: 'delivery', priority: 'high', estimateMinutes: 60, dueOffsetDays: 0, ownerHint: 'Account owner',
        checklist: ['Scope and commercials', 'Key client contacts', 'Known risks'] },
      { title: 'Draft the kickoff agenda and share it with the client', category: 'delivery', priority: 'medium', estimateMinutes: 45, dueOffsetDays: 1, ownerHint: 'Project lead', dependsOn: [1] },
      { title: 'Run the kickoff meeting', category: 'delivery', priority: 'high', estimateMinutes: 90, dueOffsetDays: 3, ownerHint: 'Project lead', dependsOn: [2],
        checklist: ['Goals and success measures', 'Roles and contacts', 'Communication cadence', 'Next steps'] },
      { title: 'Send kickoff notes and the agreed scope', category: 'delivery', priority: 'high', estimateMinutes: 45, dueOffsetDays: 4, ownerHint: 'Project lead',
        requiresReview: true, dependsOn: [3] },
      { title: 'Set up the project workspace and access', category: 'operations', priority: 'medium', estimateMinutes: 60, dueOffsetDays: 4, ownerHint: 'Operations', dependsOn: [3] },
      { title: 'Build the milestone plan', category: 'delivery', priority: 'high', estimateMinutes: 120, dueOffsetDays: 6, ownerHint: 'Project lead', requiresReview: true, dependsOn: [4] },
      { title: 'Start the risk and dependency log', category: 'delivery', priority: 'medium', estimateMinutes: 60, dueOffsetDays: 7, ownerHint: 'Project lead', dependsOn: [6] },
    ],
  },
  {
    key: 'weekly_team_review', name: 'Weekly team review', category: 'team',
    description: 'Prepare and run a short weekly review of open work, blockers and upcoming deadlines. About work, not about ranking people.',
    items: [
      { title: 'Collect updates on open work', category: 'admin', priority: 'medium', estimateMinutes: 20, dueOffsetDays: 0, ownerHint: 'Team lead' },
      { title: 'Review blockers and waiting-on items', category: 'admin', priority: 'high', estimateMinutes: 30, dueOffsetDays: 0, ownerHint: 'Team lead', dependsOn: [1] },
      { title: 'Check deadlines for the next two weeks', category: 'admin', priority: 'medium', estimateMinutes: 20, dueOffsetDays: 0, ownerHint: 'Team lead' },
      { title: 'Hold the team review meeting', category: 'admin', priority: 'medium', estimateMinutes: 45, dueOffsetDays: 1, ownerHint: 'Team lead', dependsOn: [2, 3],
        checklist: ['Accepted work and wins', 'Blockers that need help', 'Priorities for next week'] },
      { title: 'Share notes and follow-up owners', category: 'admin', priority: 'medium', estimateMinutes: 15, dueOffsetDays: 1, ownerHint: 'Team lead', dependsOn: [4] },
    ],
  },
  {
    key: 'product_release', name: 'Product release checklist', category: 'product',
    description: 'Scope freeze, regression testing, rollback plan, deployment, announcement and a post-release review.',
    items: [
      { title: 'Freeze scope and draft release notes', category: 'delivery', priority: 'high', estimateMinutes: 45, dueOffsetDays: 0, ownerHint: 'Product owner' },
      { title: 'Regression testing', category: 'delivery', priority: 'high', estimateMinutes: 240, dueOffsetDays: 2, ownerHint: 'QA', requiresEvidence: true, dependsOn: [1],
        checklist: ['Critical user journeys', 'Payments or checkout, if any', 'Accessibility smoke check'] },
      { title: 'Fix release-blocking bugs', category: 'delivery', priority: 'urgent', estimateMinutes: 240, dueOffsetDays: 3, ownerHint: 'Engineering', requiresReview: true, dependsOn: [2] },
      { title: 'Prepare the rollback plan', category: 'delivery', priority: 'high', estimateMinutes: 60, dueOffsetDays: 3, ownerHint: 'Engineering', requiresReview: true },
      { title: 'Update help docs and release notes', category: 'delivery', priority: 'medium', estimateMinutes: 90, dueOffsetDays: 4, ownerHint: 'Product owner', dependsOn: [1] },
      { title: 'Deploy to production', category: 'delivery', priority: 'high', estimateMinutes: 60, dueOffsetDays: 5, ownerHint: 'Engineering', requiresEvidence: true, dependsOn: [3, 4],
        checklist: ['Backup taken', 'Deploy', 'Smoke test', 'Watch error rates for an hour'] },
      { title: 'Announce the release to customers and support', category: 'support', priority: 'medium', estimateMinutes: 30, dueOffsetDays: 5, ownerHint: 'Product owner', dependsOn: [5, 6] },
      { title: 'Post-release review', category: 'delivery', priority: 'medium', estimateMinutes: 45, dueOffsetDays: 10, ownerHint: 'Product owner', dependsOn: [6],
        checklist: ['What went well', 'What to change next time', 'Follow-up tasks created'] },
    ],
  },
];
