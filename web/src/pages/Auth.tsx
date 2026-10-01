import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Callout, Field, Input, Select } from '../components/ui';

function AuthFrame({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-xl bg-accent text-on-accent"><CheckCircle2 className="size-5" aria-hidden /></div>
          <div className="text-[15px] font-semibold">Task Tracking & Productivity</div>
        </div>
        <div className="rounded-2xl bg-surface p-6 shadow-card ring-1 ring-line">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-[13px] text-ink-3">{footer}</div>}
      </div>
    </div>
  );
}

export function LoginPage() {
  const nav = useNavigate(); const [sp] = useSearchParams(); const qc = useQueryClient();
  const [org, setOrg] = useState(() => { try { return localStorage.getItem('org') ?? ''; } catch { return ''; } });
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [code, setCode] = useState('');
  const [mfa, setMfa] = useState(false); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const next = sp.get('next') || '/';
  const done = () => { qc.clear(); nav(next.startsWith('/') ? next : '/', { replace: true }); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      if (mfa) { await api.post('/api/auth/mfa', { code }); return done(); }
      const r = await api.post('/api/auth/login', { organization: org, email, password });
      try { localStorage.setItem('org', org); } catch { /* ignore */ }
      if (r.mfaRequired) setMfa(true); else done();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <AuthFrame title={mfa ? 'Two-step verification' : 'Sign in'} subtitle={mfa ? 'Enter the 6-digit code from your authenticator app.' : 'Plan your day, capture work and see your own report.'}
      footer={<>New organization? <Link className="font-medium text-accent-ink underline" to="/signup">Create one</Link></>}>
      <form onSubmit={submit} className="space-y-3.5">
        {err && <Callout tone="critical">{err}</Callout>}
        {!mfa ? <>
          <Field label="Organization">{(id) => <Input id={id} value={org} onChange={(e) => setOrg(e.target.value.toLowerCase())} autoComplete="organization" required placeholder="your-company" />}</Field>
          <Field label="Work email">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />}</Field>
          <Field label="Password">{(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />}</Field>
        </> : <Field label="Verification code">{(id) => <Input id={id} inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus required />}</Field>}
        <Button variant="primary" className="w-full" type="submit" loading={busy}>{mfa ? 'Verify' : 'Sign in'}</Button>
      </form>
    </AuthFrame>
  );
}

export function JoinPage() {
  const { slug, token } = useParams(); const nav = useNavigate();
  const [info, setInfo] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/api/join/${slug}/${token}`).then((i) => { setInfo(i); setName(i.name); }).catch((e) => setErr(e.message)); }, [slug, token]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api.post(`/api/join/${slug}/${token}`, { name, password }); try { localStorage.setItem('org', slug!); } catch { /* ignore */ } nav('/', { replace: true }); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <AuthFrame title={info ? `Join ${info.organization}` : 'Accept invitation'} subtitle={info ? `Signing up as ${info.email}` : undefined}>
      {err && <div className="mb-3"><Callout tone="critical">{err}</Callout></div>}
      {info && <form onSubmit={submit} className="space-y-3.5">
        <Field label="Your name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
        <Field label="Choose a password" hint="At least 10 characters.">{(id) => <Input id={id} type="password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />}</Field>
        <Button variant="primary" type="submit" className="w-full" loading={busy}>Join workspace</Button>
      </form>}
    </AuthFrame>
  );
}

export function SignupPage() {
  const nav = useNavigate();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [f, setF] = useState({ organizationName: '', slug: '', timezone: tz, name: '', email: '', password: '', plan: 'team' });
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v, ...(k === 'organizationName' && !x.slug ? {} : {}) }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await api.post('/api/auth/signup', f); try { localStorage.setItem('org', r.slug); } catch { /* ignore */ } nav('/admin?onboarding=1', { replace: true }); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <AuthFrame title="Create your organization" subtitle="You'll be the first administrator. Invite your team next." footer={<>Already have an account? <Link className="font-medium text-accent-ink underline" to="/login">Sign in</Link></>}>
      <form onSubmit={submit} className="space-y-3.5">
        {err && <Callout tone="critical">{err}</Callout>}
        <Field label="Organization name">{(id) => <Input id={id} required value={f.organizationName} onChange={(e) => { set('organizationName', e.target.value); if (!f.slug || f.slug === slugify(f.organizationName)) setF((x) => ({ ...x, organizationName: e.target.value, slug: slugify(e.target.value) })); }} />}</Field>
        <Field label="Sign-in address" hint="Used on the sign-in screen. Lowercase letters, numbers and dashes.">{(id) => <Input id={id} required pattern="[a-z0-9][a-z0-9-]{1,40}" value={f.slug} onChange={(e) => set('slug', e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Time zone">{(id) => <Input id={id} required value={f.timezone} onChange={(e) => set('timezone', e.target.value)} />}</Field>
          <Field label="Plan">{(id) => <Select id={id} value={f.plan} onChange={(e) => set('plan', e.target.value)}><option value="team">Team · 25 seats</option><option value="organization">Organization · 250</option><option value="enterprise">Enterprise</option></Select>}</Field>
        </div>
        <Field label="Your name">{(id) => <Input id={id} required value={f.name} onChange={(e) => set('name', e.target.value)} />}</Field>
        <Field label="Work email">{(id) => <Input id={id} type="email" required value={f.email} onChange={(e) => set('email', e.target.value)} />}</Field>
        <Field label="Password" hint="At least 10 characters.">{(id) => <Input id={id} type="password" minLength={10} required value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />}</Field>
        <p className="text-[12px] text-ink-3">Plans and seat limits are configuration in this build — no payment is taken.</p>
        <Button variant="primary" type="submit" className="w-full" loading={busy}>Create organization</Button>
      </form>
    </AuthFrame>
  );
}
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
