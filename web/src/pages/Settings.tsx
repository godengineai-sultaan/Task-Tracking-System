import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useMe } from '../lib/session';
import { Badge, Button, Callout, Card, Field, Input, PageHeader, useToast } from '../components/ui';

export default function Settings() {
  const me = useMe(); const qc = useQueryClient(); const toast = useToast();
  const [name, setName] = useState(me.user.name); const [tz, setTz] = useState(me.user.timezone ?? '');
  const [pw, setPw] = useState({ current: '', next: '' }); const [mfa, setMfa] = useState<any>(null); const [code, setCode] = useState('');
  const err = (e: any) => toast({ tone: 'critical', text: e.message });
  const profile = useMutation({ mutationFn: () => api.patch('/api/me', { name, timezone: tz || null }), onSuccess: () => { qc.invalidateQueries(); toast({ tone: 'good', text: 'Profile saved' }); }, onError: err });
  const pass = useMutation({ mutationFn: () => api.post('/api/me/password', pw), onSuccess: () => { setPw({ current: '', next: '' }); toast({ tone: 'good', text: 'Password changed. Other sessions were signed out.' }); }, onError: err });
  const setup = useMutation({ mutationFn: () => api.post('/api/me/mfa/setup'), onSuccess: setMfa, onError: err });
  const enable = useMutation({ mutationFn: () => api.post(me.user.mfa_enabled ? '/api/me/mfa/disable' : '/api/me/mfa/enable', { code }), onSuccess: () => { setMfa(null); setCode(''); qc.invalidateQueries({ queryKey: ['me'] }); toast({ tone: 'good', text: me.user.mfa_enabled ? 'Two-step verification turned off' : 'Two-step verification is on' }); }, onError: err });
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Settings" subtitle={`${me.user.email} · ${me.tenant.name}`} />
      <div className="space-y-4">
        <Card title="Profile">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Time zone" hint={`Leave empty to use the organization's (${me.tenant.timezone}).`}>{(id) => <Input id={id} value={tz} onChange={(e) => setTz(e.target.value)} placeholder={me.tenant.timezone} />}</Field>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2"><Button variant="primary" loading={profile.isPending} onClick={() => profile.mutate()}>Save</Button>
            <span className="text-[12px] text-ink-3">Roles: {me.user.roles.map((r) => <Badge key={r} className="mr-1">{r.replace('_', ' ')}</Badge>)}</span></div>
        </Card>
        <Card title="Password">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />}</Field>
            <Field label="New password" hint="At least 10 characters.">{(id) => <Input id={id} type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />}</Field>
          </div>
          <Button className="mt-3" loading={pass.isPending} disabled={!pw.current || pw.next.length < 10} onClick={() => pass.mutate()}>Change password</Button>
        </Card>
        <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-4" aria-hidden />Two-step verification</span>} actions={<Badge tone={me.user.mfa_enabled ? 'good' : 'neutral'}>{me.user.mfa_enabled ? 'On' : 'Off'}</Badge>}>
          {me.user.mfa_enabled ? <div className="flex flex-wrap items-end gap-2"><Field label="Enter a current code to turn it off">{(id) => <Input id={id} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} className="w-40" />}</Field>
            <Button loading={enable.isPending} disabled={code.length !== 6} onClick={() => enable.mutate()}>Turn off</Button></div>
          : !mfa ? <Button variant="primary" loading={setup.isPending} onClick={() => setup.mutate()}>Set up authenticator app</Button> : (
            <div className="flex flex-wrap gap-5">
              <img src={mfa.qr} alt="QR code for your authenticator app" className="size-40 rounded-lg bg-white p-2 ring-1 ring-line" />
              <div className="min-w-0 flex-1 space-y-3"><p className="text-[13px] text-ink-2">Scan with an authenticator app, or enter this key:</p><code className="block break-all rounded bg-surface-2 p-2 text-[12px]">{mfa.secret}</code>
                <div className="flex items-end gap-2"><Field label="6-digit code">{(id) => <Input id={id} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} className="w-32" />}</Field>
                  <Button variant="primary" loading={enable.isPending} disabled={code.length !== 6} onClick={() => enable.mutate()}>Verify & turn on</Button></div></div>
            </div>)}
        </Card>
        <Callout tone="neutral">Your data: you can see and correct your own plans, time, recaps and reports at any time. The product never captures screenshots, keystrokes, microphone audio or browser activity.</Callout>
      </div>
    </div>
  );
}
