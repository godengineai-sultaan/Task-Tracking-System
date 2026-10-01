import { beforeAll, describe, expect, it } from 'vitest';
import { drainJobs, localIso, login, makeOrg, pastWorkday, withOwner, type Org } from './helpers.js';

let org: Org; let emp: any; let mgr: any; let emp2: any; let admin: any;
beforeAll(async () => {
  org = await makeOrg();
  [emp, mgr, emp2, admin] = await Promise.all([login(org, 'emp'), login(org, 'manager'), login(org, 'emp2'), login(org, 'admin')]);
});

describe('fast capture and inline updates', () => {
  it('creates a task from one line and plans it for today', async () => {
    const parsed = await emp.post('/api/tasks/parse', { text: 'Prepare laptop PO draft today — 30 minutes' });
    expect(parsed.body).toMatchObject({ title: 'Prepare laptop PO draft', estimateMinutes: 30 });
    const t = await emp.post('/api/tasks', { title: parsed.body.title, dueDate: parsed.body.dueDate, estimateMinutes: 30, addToMyDay: true, sourceType: 'quick_capture', captureMs: 4200 });
    expect(t.status).toBe(200);
    const day = await emp.get('/api/my-day');
    expect(day.body.intendedOutcomes.map((x: any) => x.id)).toContain(t.body.id);
    const st = await emp.post(`/api/tasks/${t.body.id}/status`, { to: 'in_progress', version: t.body.version });
    expect(st.body.status).toBe('in_progress');
  });
  it('limits intended outcomes to three and records the replan reason', async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4]) ids.push((await emp.post('/api/tasks', { title: `Outcome ${n}` })).body.id);
    expect((await emp.put('/api/my-day/plan', { taskIds: ids })).status).toBe(400);
    expect((await emp.put('/api/my-day/plan', { taskIds: ids.slice(0, 3) })).status).toBe(200);
    const r = await emp.put('/api/my-day/plan', { taskIds: [ids[0], ids[3]], reason: 'Client escalation took priority' });
    expect(r.body.intendedOutcomes).toHaveLength(2);
    expect(r.body.scopeChanges.map((s: any) => s.removed_reason)).toContain('Client escalation took priority');
  });
  it('rejects stale writes with 409 (optimistic concurrency)', async () => {
    const t = (await emp.post('/api/tasks', { title: 'Concurrent edit' })).body;
    expect((await emp.patch(`/api/tasks/${t.id}`, { title: 'A', version: t.version })).status).toBe(200);
    expect((await emp.patch(`/api/tasks/${t.id}`, { title: 'B', version: t.version })).status).toBe(409);
  });
});

describe('blocked, review, evidence and reopen', () => {
  it('blocked needs a reason and records waiting-on + follow-up; unblocking resolves it', async () => {
    const t = (await emp.post('/api/tasks', { title: 'Integrate API' })).body;
    expect((await emp.post(`/api/tasks/${t.id}/status`, { to: 'blocked' })).status).toBe(400);
    const b = await emp.post(`/api/tasks/${t.id}/status`, { to: 'blocked', blocker: { reason: 'Need staging access', cause: 'access', waitingOnUserId: org.users.manager, nextFollowUp: '2030-01-01' } });
    expect(b.body.status).toBe('blocked');
    const d = (await emp.get(`/api/tasks/${t.id}`)).body;
    expect(d.blockers[0]).toMatchObject({ reason: 'Need staging access', waiting_on_user_id: org.users.manager, resolved_at: null });
    await emp.post(`/api/tasks/${t.id}/status`, { to: 'in_progress', resolution: 'Access granted' });
    expect((await emp.get(`/api/tasks/${t.id}`)).body.blockers[0].resolution).toBe('Access granted');
  });
  it('review-required work only reaches Done when a reviewer accepts; owners cannot self-accept', async () => {
    const t = (await emp.post('/api/tasks', { title: 'Feature X', requiresReview: true, reviewerId: org.users.emp2 })).body;
    expect((await emp.post(`/api/tasks/${t.id}/status`, { to: 'done' })).status).toBe(400);
    expect((await emp.post(`/api/tasks/${t.id}/status`, { to: 'in_review' })).body.status).toBe('in_review');
    expect((await emp.post(`/api/tasks/${t.id}/review`, { decision: 'accepted' })).status).toBe(403);
    const cr = await emp2.post(`/api/tasks/${t.id}/review`, { decision: 'changes_requested', note: 'Add tests' });
    expect(cr.body.status).toBe('in_progress');
    await emp.post(`/api/tasks/${t.id}/status`, { to: 'in_review' });
    const ok = await emp2.post(`/api/tasks/${t.id}/review`, { decision: 'accepted', note: 'Good' });
    expect(ok.body.status).toBe('done'); expect(ok.body.accepted_at).toBeTruthy();
  });
  it('evidence-required work cannot be completed without evidence', async () => {
    const t = (await emp.post('/api/tasks', { title: 'Payment run', requiresEvidence: true })).body;
    expect((await emp.post(`/api/tasks/${t.id}/status`, { to: 'done' })).status).toBe(400);
    await emp.post(`/api/tasks/${t.id}/evidence`, { label: 'Bank advice', url: 'https://example.com/advice' });
    expect((await emp.post(`/api/tasks/${t.id}/status`, { to: 'done' })).body.status).toBe('done');
  });
  it('reopen requires a reason, preserves history and counts as rework', async () => {
    const t = (await emp.post('/api/tasks', { title: 'Report draft' })).body;
    await emp.post(`/api/tasks/${t.id}/status`, { to: 'done' });
    expect((await emp.post(`/api/tasks/${t.id}/reopen`, { reason: '' })).status).toBe(400);
    const r = await emp.post(`/api/tasks/${t.id}/reopen`, { reason: 'Numbers were wrong' });
    expect(r.body).toMatchObject({ status: 'in_progress', reopen_count: 1, accepted_at: null });
    const h = (await emp.get(`/api/tasks/${t.id}`)).body.history.map((x: any) => x.to_status);
    expect(h).toEqual(['planned', 'done', 'in_progress']);
  });
  it('dependencies reject cycles', async () => {
    const a = (await emp.post('/api/tasks', { title: 'A' })).body, b = (await emp.post('/api/tasks', { title: 'B' })).body;
    expect((await emp.post(`/api/tasks/${a.id}/dependencies`, { dependsOnTaskId: b.id })).status).toBe(200);
    expect((await emp.post(`/api/tasks/${b.id}/dependencies`, { dependsOnTaskId: a.id })).status).toBe(400);
  });
});

describe('recurring work', () => {
  it('generates one task per occurrence even when the job runs repeatedly', async () => {
    const r = await emp.post('/api/recurring', { title: 'Daily inbox', rule: 'daily' });
    expect(r.status).toBe(200);
    await drainJobs(); await admin.post('/api/recurring', { title: 'noop', rule: 'monthly', monthDay: 28 }); await drainJobs();
    await withOwner((db) => db.query(`insert into jobs (tenant_id, kind) values ($1,'recurring.generate'),($1,'recurring.generate')`, [org.tenantId]));
    await drainJobs();
    const n = await withOwner((db) => db.query(`select occurrence_date, count(*)::int c from tasks where recurring_template_id = $1 group by 1`, [r.body.id]));
    expect(n.rows.length).toBeGreaterThan(0);
    expect(n.rows.every((x: any) => x.c === 1)).toBe(true);
  });
});

describe('recap confirmation, correction and report reconciliation', () => {
  it('confirm → v1 snapshot; time correction → new version; recap correction requires a reason', async () => {
    const day = pastWorkday(org.tz, 1); const date = day.toISODate()!;
    const t = (await emp.post('/api/tasks', { title: 'Recap work' })).body;
    const e = await emp.post('/api/time-entries', { taskId: t.id, category: 'task', startedAt: localIso(org.tz, date, '10:00'), endedAt: localIso(org.tz, date, '12:00') });
    expect(e.status).toBe(200);
    expect((await emp.post('/api/recap/confirm', { date, summary: 'Did the recap work', overheadMs: 45000 })).status).toBe(200);
    await drainJobs();
    let rep = (await emp.get(`/api/reports/individual?kind=day&date=${date}`)).body;
    expect(rep.days[0].time.explainedMinutes).toBe(120);
    expect(rep.versions.map((v: any) => v.version)).toEqual([1]);
    expect(rep.reportState).toBe('confirmed');
    // Correction of a time entry after confirmation: reason required, history kept, new report version.
    expect((await emp.patch(`/api/time-entries/${e.body.entry.id}`, { endedAt: localIso(org.tz, date, '11:00'), version: e.body.entry.version, reason: '' })).status).toBe(400);
    const c = await emp.patch(`/api/time-entries/${e.body.entry.id}`, { endedAt: localIso(org.tz, date, '11:00'), version: e.body.entry.version, reason: 'Forgot to stop timer' });
    expect(c.status).toBe(200);
    await drainJobs();
    rep = (await emp.get(`/api/reports/individual?kind=day&date=${date}`)).body;
    expect(rep.days[0].time.explainedMinutes).toBe(60);
    expect(rep.versions.map((v: any) => v.version)).toEqual([2, 1]);
    const revs = (await emp.get(`/api/time-entries/${e.body.entry.id}/revisions`)).body;
    expect(revs[0].reason).toBe('Forgot to stop timer');
    // Recap correction needs a reason and keeps the old version.
    expect((await emp.post('/api/recap/confirm', { date, summary: 'Changed' })).status).toBe(400);
    expect((await emp.post('/api/recap/confirm', { date, summary: 'Changed', changeReason: 'Added missing context' })).status).toBe(200);
    const recap = (await emp.get(`/api/recap?date=${date}`)).body;
    expect(recap.versions.map((v: any) => v.version)).toEqual([2, 1]);
    // CSV export reconciles with the corrected figures.
    const ex = await emp.post('/api/exports', { format: 'csv', report: 'individual', params: { userId: org.users.emp, kind: 'day', start: date, end: date } });
    await drainJobs();
    const file = await emp.get(`/api/exports/${ex.body.id}/file`);
    expect(file.status).toBe(200);
    const row = String(file.body).split('\n').find((l: string) => l.startsWith(date))!;
    expect(row.split(',')[3]).toBe('60');
  });
  it('missing recap is Insufficient Data; zero-capacity is Not Applicable; confirmed no-work differs from missing', async () => {
    const d1 = pastWorkday(org.tz, 2).toISODate()!;
    expect((await emp2.get(`/api/reports/individual?kind=day&date=${d1}`)).body.assessment.label).toBe('insufficient_data');
    // A Saturday
    const { DateTime } = await import('luxon');
    let sat = DateTime.now().setZone(org.tz).startOf('day'); while (sat.weekday !== 6) sat = sat.minus({ days: 1 });
    const r = (await emp2.get(`/api/reports/individual?kind=day&date=${sat.toISODate()}`)).body;
    expect(r.assessment.label).toBe('not_applicable'); expect(r.days[0].time.coverage).toBeNull();
    await emp2.post('/api/recap/confirm', { date: d1, summary: '', dayType: 'no_work' });
    const r2 = (await emp2.get(`/api/reports/individual?kind=day&date=${d1}`)).body;
    expect(r2.assessment.label).toBe('needs_attention'); expect(r2.days[0].recap.dayType).toBe('no_work');
  });
  it('leave removes capacity so reports show Not Applicable, not low productivity', async () => {
    const d = pastWorkday(org.tz, 3).toISODate()!;
    expect((await emp2.post('/api/calendar/leave', { startDate: d, endDate: d, portion: 'full', kind: 'sick' })).status).toBe(200);
    const r = (await emp2.get(`/api/reports/individual?kind=day&date=${d}`)).body;
    expect(r.days[0].capacity.status).toBe('leave'); expect(r.assessment.label).toBe('not_applicable');
  });
});

describe('manager review actions never overwrite the employee record', () => {
  it('acknowledge, clarification request/response and follow-up are visible and preserve the recap', async () => {
    const date = pastWorkday(org.tz, 4).toISODate()!;
    await emp.post('/api/recap/confirm', { date, summary: 'Original text' });
    expect((await mgr.post('/api/manager-reviews', { subjectUserId: org.users.emp, date, action: 'acknowledge' })).status).toBe(200);
    const q = await mgr.post('/api/manager-reviews', { subjectUserId: org.users.emp, date, action: 'clarification_request', note: 'Which client?' });
    expect((await emp.post('/api/manager-reviews', { subjectUserId: org.users.emp, date, action: 'clarification_response', note: 'Globex', parentId: q.body.id })).status).toBe(200);
    const fu = await mgr.post('/api/manager-reviews', { subjectUserId: org.users.emp, date, action: 'follow_up', followUp: { title: 'Send Globex summary' } });
    expect(fu.body.related_task_id).toBeTruthy();
    const recap = (await emp.get(`/api/recap?date=${date}`)).body;
    expect(recap.review.summary).toBe('Original text'); expect(recap.review.status).toBe('manager_reviewed');
    expect(recap.managerReviews.map((m: any) => m.action)).toEqual(['acknowledge', 'clarification_request', 'clarification_response', 'follow_up']);
    expect(recap.managerReviews[1].resolved_at).toBeTruthy();
    const notes = (await emp.get('/api/notifications')).body.map((n: any) => n.kind);
    expect(notes).toEqual(expect.arrayContaining(['review_acknowledge', 'review_clarification_request', 'review_follow_up']));
  });
});
