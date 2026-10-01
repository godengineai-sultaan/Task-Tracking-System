export const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog', planned: 'Planned', in_progress: 'In Progress', blocked: 'Blocked', in_review: 'In Review', done: 'Done', cancelled: 'Cancelled',
};
export const STATUSES = ['backlog', 'planned', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'];
export const PRIORITY_LABEL: Record<string, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'None' };
export const CATEGORY_LABEL: Record<string, string> = { delivery: 'Delivery', admin: 'Admin', finance: 'Finance', support: 'Support', research: 'Research', sales: 'Sales', operations: 'Operations', other: 'Other' };
export const TIME_CATS = [
  { key: 'task', label: 'Task work', color: 'var(--c-task)' },
  { key: 'meeting', label: 'Meetings', color: 'var(--c-meeting)' },
  { key: 'admin', label: 'Admin', color: 'var(--c-admin)' },
  { key: 'learning', label: 'Learning', color: 'var(--c-learning)' },
  { key: 'other', label: 'Other declared', color: 'var(--c-other)' },
] as const;
export const ASSESSMENT: Record<string, { label: string; tone: 'good' | 'warning' | 'neutral' | 'info' }> = {
  on_track: { label: 'On Track', tone: 'good' }, needs_attention: { label: 'Needs Attention', tone: 'warning' },
  insufficient_data: { label: 'Insufficient Data', tone: 'neutral' }, not_applicable: { label: 'Not Applicable', tone: 'info' },
};

export function hm(min: number | null | undefined) {
  if (min === null || min === undefined) return '—';
  const m = Math.round(min);
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}
export const pct = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? 'N/A' : `${(v * 100).toFixed(digits)}%`);
export function fmtDate(d: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) {
  if (!d) return '—';
  const dt = d.length === 10 ? new Date(d + 'T12:00:00') : new Date(d);
  return dt.toLocaleDateString(undefined, opts);
}
export function fmtTime(d: string | null | undefined, tz?: string) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: tz });
}
export function fmtDateTime(d: string | null | undefined, tz?: string) {
  if (!d) return '—';
  return new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz });
}
export function relDue(due: string | null, today: string) {
  if (!due) return null;
  if (due === today) return { text: 'Today', tone: 'warning' as const };
  if (due < today) {
    const days = Math.round((Date.parse(today) - Date.parse(due)) / 86400000);
    return { text: `${days}d overdue`, tone: 'critical' as const };
  }
  const days = Math.round((Date.parse(due) - Date.parse(today)) / 86400000);
  return { text: days === 1 ? 'Tomorrow' : days < 7 ? fmtDate(due, { weekday: 'short' }) : fmtDate(due), tone: 'neutral' as const };
}
export function addDays(d: string, n: number) {
  const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
}
export function minutesSince(iso: string) { return Math.max(0, (Date.now() - Date.parse(iso)) / 60000); }
export function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join(''); }
