import { tzOffsetMinutes } from '../components/time';

/** UTC ISO bounds of a local calendar date in a time zone. */
export function localDayBoundsIso(date: string, tz: string) {
  const at = (d: string) => { const probe = new Date(`${d}T00:00:00Z`); return new Date(probe.getTime() - tzOffsetMinutes(tz, probe) * 60000).toISOString(); };
  const next = new Date(`${date}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  return { start: at(date), end: at(next.toISOString().slice(0, 10)) };
}

export async function downloadExport(api: any, body: any, toast: (t: any) => void) {
  const ex = await api.post('/api/exports', body);
  toast({ tone: 'info', text: `Preparing ${body.format.toUpperCase()}…` });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, i < 5 ? 600 : 1500));
    const s = await api.get(`/api/exports/${ex.id}`);
    if (s.status === 'ready') { window.location.href = `/api/exports/${ex.id}/file`; toast({ tone: 'good', text: `${s.filename} ready` }); return; }
    if (s.status === 'failed') { toast({ tone: 'critical', text: `Export failed: ${s.error}` }); return; }
  }
  toast({ tone: 'critical', text: 'Export is taking longer than expected. Check again shortly.' });
}
