import { one } from '../../lib/db.js';
import { registerJob } from '../../lib/jobs.js';
import { onTaskEvent } from '../../services/events.js';
import { notify } from '../../services/notify.js';
import { registerTeamWeeklyExport, remindWeeklyReviewers } from '../../services/ext/teamreview.js';
import { registerTenantTick } from '../index.js';

/** Background jobs, tenant ticks and task-event listeners for the 'teamreview' feature area. */
export default function register() {
  // The export worker renders 'team_weekly' too, so register it in job processes as well as the API.
  registerTeamWeeklyExport();

  // Monday reminder to team managers (idempotent per manager per week).
  registerJob('teamreview.remind', async (db, _p, job) => { await remindWeeklyReviewers(db, job.tenantId!); });
  registerTenantTick('teamreview.remind');

  // Tell the reviewer when a follow-up task created from their weekly review is accepted as done.
  onTaskEvent(async (db, ev) => {
    if (ev.depth >= 3) return;
    if (ev.type !== 'task.status_changed' || ev.to !== 'done' || ev.task.source_type !== 'follow_up') return;
    const reviewId = ev.task.source_ref?.weekly_review_id;
    if (typeof reviewId !== 'string') return;
    const wr = await one(db, `select reviewer_id from weekly_reviews where id = $1`, [reviewId]);
    if (!wr || wr.reviewer_id === ev.actorId) return;
    await notify(db, ev.tenantId, wr.reviewer_id, 'weekly_review_follow_up_done', `Follow-up done: ${ev.task.title}`, 'Created from your weekly team review.', `/tasks/${ev.task.id}`);
  });
}
