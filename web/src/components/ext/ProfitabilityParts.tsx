import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BellRing, Pencil, Trash2, Wallet } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, pct } from '../../lib/format';
import { Badge, Button, Callout, Card, ErrorState, Field, Input, Modal, Select, Skeleton, Textarea, cx, useToast } from '../ui';
import { ReasonDialog } from '../TaskStatus';

type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'info';
export const BUDGET_STATUS: Record<string, { label: string; tone: Tone }> = {
  no_budget: { label: 'No budget', tone: 'neutral' }, not_measurable: { label: 'Not measurable', tone: 'neutral' }, on_track: { label: 'On track', tone: 'good' },
  watch: { label: 'Watch', tone: 'warning' }, at_risk: { label: 'At risk', tone: 'serious' }, over_budget: { label: 'Over budget', tone: 'critical' },
};
export const BILLING_LABEL: Record<string, string> = { fixed_fee: 'Fixed fee', time_and_materials: 'Time & materials', internal: 'Internal' };

export function fmtMoney(v: number | null | undefined, currency: string, compact = false) {
  if (v === null || v === undefined) return '—';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: compact ? 1 : 0, notation: compact ? 'compact' : 'standard' }).format(v); }
  catch { return `${currency} ${Math.round(v).toLocaleString()}`; }
}
export const fmtHours = (h: number | null | undefined) => (h === null || h === undefined ? '—' : `${h.toLocaleString(undefined, { maximumFractionDigits: 1 })}h`);

export function BudgetStatus({ label, className }: { label: string; className?: string }) {
  const s = BUDGET_STATUS[label] ?? BUDGET_STATUS.not_measurable;
  return <Badge tone={s.tone} className={className}>{s.label}</Badge>;
}

/** Small chip for the Projects list. */
export function BudgetBadge({ b }: { b: { label: string; consumption: number | null; basis: string } }) {
  const s = BUDGET_STATUS[b.label] ?? BUDGET_STATUS.not_measurable;
  return <Badge tone={s.tone} icon={<Wallet className="size-3" aria-hidden />}>
    <span>{b.basis === 'hours' ? 'Hours' : 'Budget'} {b.consumption === null ? s.label.toLowerCase() : pct(b.consumption)}</span><span className="sr-only">, {s.label}, {b.basis === 'hours' ? 'hours basis' : 'amount and hours basis'}</span>
  </Badge>;
}

/**
 * Consumption bar: fill = used to date, vertical line = forecast at completion, tick = 100% of budget when the scale exceeds it.
 * Focusable with a tooltip; the same numbers are always printed next to it.
 */
export function BurnBar({ label, value, forecast, detail, thresholds = [75, 90, 100], className }: {
  label: string; value: number | null; forecast?: number | null; detail: string; thresholds?: number[]; className?: string;
}) {
  if (value === null) return <span className="text-[12px] text-ink-3">Not measurable</span>;
  const domain = Math.min(2, Math.max(1, value, forecast ?? 0));
  const pos = (v: number) => `${(Math.min(v, domain) / domain) * 100}%`;
  const crossed = thresholds.filter((t) => t < 100 && value * 100 >= t).length;
  const fill = value >= 1 ? 'bg-critical' : crossed >= 2 ? 'bg-serious' : crossed === 1 ? 'bg-warning' : 'bg-accent';
  const text = `${label}: ${pct(value)} used${forecast !== null && forecast !== undefined ? `, forecast ${pct(forecast)} at completion` : ''}. ${detail}`;
  return (
    <div className={cx('group relative min-w-[96px] rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent', className)} tabIndex={0} role="img" aria-label={text}>
      <div className="relative h-2.5 overflow-hidden rounded-full bg-surface-2 ring-1 ring-inset ring-line">
        <div className={cx('h-full rounded-full', fill)} style={{ width: pos(value) }} />
        {domain > 1 && <div className="absolute inset-y-0 w-px bg-ink-3" style={{ left: pos(1) }} />}
      </div>
      {forecast !== null && forecast !== undefined && <div className="absolute -top-0.5 h-3.5 w-0.5 rounded bg-ink" style={{ left: `calc(${pos(forecast)} - 1px)` }} />}
      <span role="presentation" className="pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 hidden w-max max-w-[260px] rounded-md bg-ink px-2 py-1 text-[12px] leading-snug text-bg shadow-lg group-hover:block group-focus:block">{text}</span>
    </div>
  );
}
export function BarLegend() {
  return <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
    <span className="inline-flex items-center gap-1.5"><span className="flex h-2 w-6 overflow-hidden rounded-full" aria-hidden><span className="flex-1 bg-accent" /><span className="flex-1 bg-warning" /><span className="flex-1 bg-critical" /></span>Used to date (colour = alert level)</span>
    <span className="inline-flex items-center gap-1.5"><span className="h-3 w-0.5 rounded bg-ink" aria-hidden />Forecast at completion</span>
    <span className="inline-flex items-center gap-1.5"><span className="h-3 w-px bg-ink-3" aria-hidden />100% of budget (when exceeded)</span>
  </p>;
}

const ALERT_LABEL: Record<string, string> = { amount: 'of budget amount', hours: 'of budgeted hours', forecast_amount: 'Forecast cost over budget', forecast_hours: 'Forecast hours over budget' };

/** Budget card on the project page: burn bars, forecast, alerts and (for permitted cost viewers) set/edit. */
export function BudgetCard({ projectId }: { projectId: string }) {
  const q = useQuery<any>({ queryKey: ['budget', projectId], queryFn: () => api.get(`/api/projects/${projectId}/budget`), retry: (n, e: any) => e?.status !== 403 && n < 2 });
  const [editing, setEditing] = useState(false);
  if ((q.error as any)?.status === 403) return null;
  if (q.isLoading) return <Card title="Budget"><Skeleton className="h-28" /></Card>;
  if (q.error) return <Card title="Budget"><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;
  const d = q.data, b = d.budget, m = d.money, h = d.hours;
  return (
    <Card title="Budget" subtitle={b ? `${BILLING_LABEL[b.billingType]}${b.startDate || b.endDate ? ` · ${fmtDate(b.startDate)} – ${fmtDate(b.endDate)}` : ''}` : undefined}
      actions={d.canEdit && <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)}>{b ? 'Edit' : 'Set budget'}</Button>}>
      {d.access === 'hours' && <p className="mb-3 text-[12px] text-ink-3">Hours view. Money figures are visible to cost viewers only.</p>}
      {!b ? (
        <div className="space-y-2 text-[13px] text-ink-2">
          <p>No budget set. {fmtHours(h.toDate)} of confirmed time recorded on this project so far{m && m.costToDate ? ` (${fmtMoney(m.costToDate, m.currency)} cost)` : ''}.</p>
          {!d.canEdit && <p className="text-[12px] text-ink-3">A cost viewer who owns or leads this project can set one.</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2"><BudgetStatus label={d.status.label} />{d.status.reasons.map((r: string) => <span key={r} className="text-[12px] text-ink-2">{r}</span>)}</div>
          {m && m.budgetAmount !== null && (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2 text-[13px]"><span className="font-medium">{m.consumptionBasis === 'billable_value' ? 'Billable value vs cap' : 'Cost vs budget'}</span>
                <span className="text-ink-2">{fmtMoney(m.consumptionBasis === 'billable_value' ? m.revenue : m.costToDate, m.currency)} / {fmtMoney(m.budgetAmount, m.currency)}</span></div>
              <BurnBar label="Budget amount" value={m.consumption} forecast={m.forecastConsumption} thresholds={b.alertThresholds}
                detail={`Forecast ${fmtMoney(m.consumptionBasis === 'billable_value' ? m.forecastRevenue : m.forecastCost, m.currency)}.`} />
            </div>)}
          {h.budget !== null && (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2 text-[13px]"><span className="font-medium">Hours vs budget</span><span className="text-ink-2">{fmtHours(h.toDate)} / {fmtHours(h.budget)}</span></div>
              <BurnBar label="Budgeted hours" value={h.consumption} forecast={h.forecastConsumption} thresholds={b.alertThresholds} detail={`Forecast ${fmtHours(h.forecastAtCompletion)}.`} />
            </div>)}
          <BarLegend />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
            {m && <><Def k="Cost to date" v={fmtMoney(m.costToDate, m.currency)} />
              {m.revenue !== null && <Def k="Revenue" v={fmtMoney(m.revenue, m.currency)} />}
              {m.margin !== null && <Def k="Margin" v={<span className={m.margin < 0 ? 'text-critical-ink' : ''}>{fmtMoney(m.margin, m.currency)} ({pct(m.marginPct)})</span>} />}
              <Def k="Forecast cost" v={fmtMoney(m.forecastCost, m.currency)} />
              {m.forecastMargin !== null && <Def k="Forecast margin" v={fmtMoney(m.forecastMargin, m.currency)} />}
              <Def k="Cost burn" v={`${fmtMoney(m.burnPerWeek, m.currency)}/wk`} /></>}
            <Def k="Hours burn" v={`${fmtHours(h.burnPerWeek)}/wk`} />
            <Def k="Forecast hours" v={fmtHours(h.forecastAtCompletion)} />
            <Def k="Estimate coverage" v={d.estimates.openTasks ? `${pct(d.estimates.coverage)} of ${d.estimates.openTasks} open` : 'No open tasks'} />
            {(m?.runwayWeeks ?? h.runwayWeeks) !== null && <Def k="Runway at current burn" v={`${(m?.runwayWeeks ?? h.runwayWeeks).toFixed(1)} wk`} />}
          </dl>
          {m && m.unpricedHours > 0 && <Callout tone="warning" icon={<AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}>
            {fmtHours(m.unpricedHours)} unpriced and excluded from cost (not priced at zero): {m.unpriced.map((u: any) => `${u.name} ${fmtHours(u.hours)} (${u.reason === 'currency' ? 'rate in another currency' : 'no cost rate'})`).join(', ')}.</Callout>}
          {d.alerts.length > 0 && <div>
            <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-medium"><BellRing className="size-3.5" aria-hidden />Alerts sent</h3>
            <ul className="space-y-0.5 text-[12px] text-ink-2">{d.alerts.slice(0, 6).map((a: any) => <li key={a.id}>{a.threshold ? `${a.threshold}% ${ALERT_LABEL[a.kind]}` : ALERT_LABEL[a.kind]} · {fmtDateTime(a.created_at)}</li>)}</ul>
          </div>}
          {d.access === 'money' && b.notes && <p className="whitespace-pre-line text-[12px] text-ink-2">{b.notes}</p>}
        </div>)}
      <details className="mt-3 text-[12px] text-ink-2">
        <summary className="cursor-pointer rounded font-medium text-ink-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">How this is calculated</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">{d.facts.map((f: string) => <li key={f}>{f}</li>)}</ul>
        <p className="mt-2 font-medium text-ink-3">Assumptions</p>
        <ul className="mt-1 list-disc space-y-1 pl-4 text-ink-3">{d.assumptions.map((f: string) => <li key={f}>{f}</li>)}</ul>
      </details>
      {d.canEdit && <BudgetForm open={editing} onClose={() => setEditing(false)} projectId={projectId} budget={b} currency={m?.currency ?? 'INR'} />}
    </Card>
  );
}
function Def({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-[12px] text-ink-3">{k}</dt><dd className="font-medium tabular-nums">{v}</dd></div>;
}

const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));
function BudgetForm({ open, onClose, projectId, budget, currency }: { open: boolean; onClose: () => void; projectId: string; budget: any; currency: string }) {
  const qc = useQueryClient(); const toast = useToast();
  const init = () => ({ billingType: budget?.billingType ?? 'fixed_fee', currency: budget?.currency ?? currency, budgetAmount: budget?.budgetAmount?.toString() ?? '',
    budgetHours: budget?.budgetHours?.toString() ?? '', billRate: budget?.billRate?.toString() ?? '', startDate: budget?.startDate ?? '', endDate: budget?.endDate ?? '',
    thresholds: (budget?.alertThresholds ?? [75, 90, 100]).join(', '), notes: budget?.notes ?? '' });
  const [f, setF] = useState(init);
  const [removing, setRemoving] = useState(false);
  const [tried, setTried] = useState(false);
  useEffect(() => { if (open) { setF(init()); setTried(false); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => { qc.invalidateQueries({ queryKey: ['budget', projectId] }); qc.invalidateQueries({ queryKey: ['profitability'] }); qc.invalidateQueries({ queryKey: ['budget-badges'] }); };
  const onErr = (e: any) => { if (e.status === 409) refresh(); toast({ tone: 'critical', text: e.message }); };
  const thresholds = f.thresholds.split(/[,\s]+/).filter(Boolean).map(Number);
  const badThresholds = !thresholds.length || thresholds.length > 6 || thresholds.some((t: number) => !Number.isInteger(t) || t < 1 || t > 500);
  // Same rules as the server; "missing" errors show after a save attempt, format errors as you type.
  const amount = numOrNull(f.budgetAmount), hours = numOrNull(f.budgetHours), rate = numOrNull(f.billRate);
  const negative = (v: number | null) => v !== null && !(v >= 0);
  const missing: Record<string, string | null> = {
    currency: /^[A-Z]{3}$/.test(f.currency) ? null : 'Use a 3-letter code such as INR or USD',
    budgetAmount: f.billingType === 'fixed_fee' && !amount ? 'Enter the fixed fee' : amount === null && hours === null ? 'Set an amount, budget hours, or both' : null,
    billRate: f.billingType === 'time_and_materials' && rate === null ? 'Time & materials needs a bill rate' : null,
  };
  const wrong: Record<string, string | null> = {
    budgetAmount: negative(amount) ? 'Enter 0 or more' : null, budgetHours: negative(hours) ? 'Enter 0 or more' : null,
    billRate: f.billingType === 'time_and_materials' && negative(rate) ? 'Enter 0 or more' : null,
    thresholds: badThresholds ? 'Up to 6 whole numbers from 1 to 500, comma-separated' : null,
    endDate: f.startDate && f.endDate && f.endDate < f.startDate ? 'End date is before the start date' : null,
  };
  const err = (k: string) => wrong[k] ?? (tried ? missing[k] ?? null : null);
  const submit = () => { if ([...Object.values(missing), ...Object.values(wrong)].some(Boolean)) setTried(true); else save.mutate(); };
  const save = useMutation({
    mutationFn: () => api.put(`/api/projects/${projectId}/budget`, { billingType: f.billingType, currency: f.currency, budgetAmount: numOrNull(f.budgetAmount), budgetHours: numOrNull(f.budgetHours),
      billRate: f.billingType === 'time_and_materials' ? numOrNull(f.billRate) : null, startDate: f.startDate || null, endDate: f.endDate || null, alertThresholds: thresholds, notes: f.notes,
      version: budget?.version }),
    onSuccess: () => { refresh(); toast({ tone: 'good', text: 'Budget saved' }); onClose(); }, onError: onErr,
  });
  const remove = useMutation({ mutationFn: (reason: string) => api.del(`/api/projects/${projectId}/budget`, { version: budget.version, reason }),
    onSuccess: () => { refresh(); setRemoving(false); toast({ tone: 'good', text: 'Budget removed' }); onClose(); }, onError: onErr });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const amountLabel = f.billingType === 'fixed_fee' ? 'Fixed fee' : f.billingType === 'time_and_materials' ? 'Not-to-exceed amount' : 'Budget amount';
  return (
    <>
      <Modal open={open && !removing} onClose={onClose} title={budget ? 'Edit budget' : 'Set budget'}
        footer={<>{budget && <Button variant="ghost" className="mr-auto text-critical-ink" icon={<Trash2 className="size-4" />} onClick={() => setRemoving(true)}>Remove</Button>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>Save budget</Button></>}>
        <form className="grid gap-3" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Billing">{(id) => <Select id={id} value={f.billingType} onChange={set('billingType')}>{Object.entries(BILLING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
            <Field label="Currency" hint="3-letter code" error={err('currency')}>{(id) => <Input id={id} aria-invalid={!!err('currency')} value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })} />}</Field>
            <Field label={amountLabel} hint={f.billingType === 'fixed_fee' ? 'Revenue = this fee' : 'Optional if you set hours'} error={err('budgetAmount')}>{(id) => <Input id={id} aria-invalid={!!err('budgetAmount')} type="number" min={0} step="any" inputMode="decimal" value={f.budgetAmount} onChange={set('budgetAmount')} />}</Field>
            <Field label="Budget hours" hint="Optional" error={err('budgetHours')}>{(id) => <Input id={id} aria-invalid={!!err('budgetHours')} type="number" min={0} step="any" inputMode="decimal" value={f.budgetHours} onChange={set('budgetHours')} />}</Field>
            {f.billingType === 'time_and_materials' && <Field label="Bill rate per hour" hint="Revenue = hours x rate" error={err('billRate')}>{(id) => <Input id={id} aria-invalid={!!err('billRate')} type="number" min={0} step="any" inputMode="decimal" value={f.billRate} onChange={set('billRate')} />}</Field>}
            <Field label="Alert thresholds (%)" error={err('thresholds')} hint="Alerts once per threshold">{(id) => <Input id={id} aria-invalid={!!err('thresholds')} value={f.thresholds} onChange={set('thresholds')} />}</Field>
            <Field label="Start date" hint="Earlier time is excluded">{(id) => <Input id={id} type="date" value={f.startDate} onChange={set('startDate')} />}</Field>
            <Field label="End date" error={err('endDate')}>{(id) => <Input id={id} aria-invalid={!!err('endDate')} type="date" value={f.endDate} onChange={set('endDate')} />}</Field>
          </div>
          <Field label="Notes" hint="Visible to cost viewers only">{(id) => <Textarea id={id} rows={2} value={f.notes} onChange={set('notes')} />}</Field>
          <button type="submit" hidden />
        </form>
      </Modal>
      <ReasonDialog open={removing} onClose={() => setRemoving(false)} onSubmit={(r) => remove.mutate(r)} loading={remove.isPending} title="Remove budget" label="Why remove this budget?" />
    </>
  );
}
