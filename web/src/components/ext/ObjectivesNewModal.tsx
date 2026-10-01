import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useMe } from '../../lib/session';
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '../ui';
import { useUsers } from '../TaskStatus';
import { ProductSelect, productParam } from './ProductParts';
import { useDefaultProduct, usePortfolio } from '../../lib/portfolio';

/** Last day of the current quarter, or of the next one when fewer than 30 days remain. A visible, editable default. */
function quarterEnd(today: string) {
  const [y, m] = today.split('-').map(Number);
  const qEnd = Math.ceil(m / 3) * 3;
  let end = new Date(Date.UTC(y, qEnd, 0));
  if ((end.getTime() - Date.parse(`${today}T00:00:00Z`)) / 864e5 < 30) end = new Date(Date.UTC(y, qEnd + 3, 0));
  return end.toISOString().slice(0, 10);
}

/** Create an objective (leadership / system admin). Used by the Objectives list and the Leadership card. */
export function NewObjectiveModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast(); const users = useUsers(); const nav = useNavigate(); const me = useMe();
  const pf = usePortfolio(); const defaultProduct = useDefaultProduct();
  const blank = () => ({ title: '', description: '', ownerId: me.user.id, periodStart: me.today, periodEnd: quarterEnd(me.today), product: defaultProduct || 'none' });
  const [f, setF] = useState(blank);
  const bad = f.periodStart && f.periodEnd && f.periodEnd < f.periodStart;
  const close = () => { setF(blank()); onClose(); };
  const m = useMutation({
    mutationFn: () => api.post('/api/objectives/create', { title: f.title, description: f.description, ownerId: f.ownerId || null, periodStart: f.periodStart || null, periodEnd: f.periodEnd || null,
      ...(pf.enabled ? { productId: productParam(f.product) } : {}) }),
    onSuccess: (o: any) => { qc.invalidateQueries({ queryKey: ['objectives-overview'] }); qc.invalidateQueries({ queryKey: ['leadership'] }); toast({ tone: 'good', text: 'Objective created' }); close(); nav(`/objectives/${o.id}`); },
    onError: (e: any) => toast({ tone: 'critical', text: e.message }),
  });
  const list: any[] = users.data ?? [];
  return (
    <Modal open={open} onClose={close} title="New objective"
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={!f.title.trim() || !!bad} onClick={() => m.mutate()}>Create objective</Button></>}>
      <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (f.title.trim() && !bad) m.mutate(); }}>
        <Field label="Objective">{(id) => <Input id={id} value={f.title} maxLength={300} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="What outcome should be true by the end of the period?" />}</Field>
        <Field label="Description (optional)">{(id) => <Textarea id={id} rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <Field label="Owner" hint="The owner keeps key results up to date and posts check-ins.">{(id) => <Select id={id} value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}>
          {!list.some((u) => u.id === me.user.id) && <option value={me.user.id}>{me.user.name} (me)</option>}
          {list.map((u) => <option key={u.id} value={u.id}>{u.name}{u.id === me.user.id ? ' (me)' : ''}</option>)}</Select>}</Field>
        {pf.enabled && <Field label="Product">{(id) => <ProductSelect id={id} value={f.product} onChange={(v) => setF({ ...f, product: v })} />}</Field>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Period start">{(id) => <Input id={id} type="date" value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} />}</Field>
          <Field label="Period end" error={bad ? 'End must be on or after the start' : null} hint="Needed for the early warning">{(id) => <Input id={id} type="date" value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} />}</Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
