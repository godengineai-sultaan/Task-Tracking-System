import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { initials } from '../../lib/format';
import { useMe } from '../../lib/session';
import { cx } from '../ui';

export interface Branding {
  displayName: string; accent: string | null; defaultAccent: string; version: number; updatedAt: string | null;
  logo: { url: string; mime: string } | null; weeklyDrafts?: boolean; canEdit: boolean;
}
export const useBranding = () => useQuery({ queryKey: ['branding'], queryFn: () => api.get<Branding>('/api/branding'), staleTime: 5 * 60_000 });

// ---------- Colour maths (WCAG 2.x). Mirrors server/src/services/ext/clientbrand-brand.ts ----------
export const HEX = /^#[0-9a-f]{6}$/i;
export const MIN_CONTRAST = 4.5;
const ch = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c: number[]) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
const lum = (h: string) => { const [r, g, b] = rgb(h).map(ch); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export function contrast(a: string, b: string) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
export const contrastWithWhite = (h: string) => contrast(h, '#ffffff');
const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
function toHsl(h: string): [number, number, number] {
  const [r, g, b] = rgb(h).map((v) => v / 255); const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  return [(max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6, s, l];
}
function fromHsl(h: number, s: number, l: number) {
  const f = (n: number) => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
  return hex([f(0), f(8), f(4)]);
}
/** Same rule as the server: the nearest darker shade (same hue/saturation) with >= 4.5:1 for white text. */
export function nearestAccessibleShade(h: string) {
  if (contrastWithWhite(h) >= MIN_CONTRAST) return h.toLowerCase();
  const [hh, s, l] = toHsl(h);
  for (let x = l; x >= 0; x -= 0.0025) { const c = fromHsl(hh, s, x); if (contrastWithWhite(c) >= MIN_CONTRAST) return c; }
  return '#000000';
}
/** Walk from `from` toward `to` until `ok` holds (or give up at `to`). */
const walk = (from: string, to: string, ok: (c: string) => boolean) => { for (let t = 0; t <= 1; t += 0.01) { const c = mix(from, to, t); if (ok(c)) return c; } return to; };

// Surfaces from index.css that accent text and soft fills must contrast with.
const LIGHT = { surface: '#fcfcfb', bg: '#f9f9f7', muted: '#6f6d68' }, DARK = { surface: '#1a1a19', bg: '#0d0d0d', muted: '#a3a29a' };
/** Derive light and dark token values from one accessible accent. Every derived value is computed, never user text. */
export function accentPalette(accent: string) {
  // Soft fills stay light/dark enough that muted text (--ink-3) placed on them still reads at >= 4.5:1.
  const softL = walk(mix(accent, '#ffffff', 0.9), '#ffffff', (c) => contrast(c, LIGHT.muted) >= 4.6);
  const softD = walk(mix(accent, DARK.bg, 0.78), DARK.bg, (c) => contrast(c, DARK.muted) >= 4.6);
  const inkL = walk(accent, '#000000', (c) => contrast(c, softL) >= 4.5 && contrast(c, LIGHT.surface) >= 4.5);
  const inkD = walk(accent, '#ffffff', (c) => contrast(c, softD) >= 5.5 && contrast(c, DARK.surface) >= 5.5);
  // Dark mode: keep white text >= 4.5:1 while lifting very dark accents so focus rings and fills stay visible (>= 3:1) on the dark page.
  const lifted = contrast(accent, DARK.bg) >= 3 ? accent : walk(accent, '#ffffff', (c) => contrast(c, DARK.bg) >= 3);
  return { light: { accent, ink: inkL, soft: softL }, dark: { accent: contrastWithWhite(lifted) >= MIN_CONTRAST ? lifted : accent, ink: inkD, soft: softD } };
}
export function accentCss(accent: string) {
  const p = accentPalette(accent);
  const v = (x: { accent: string; ink: string; soft: string }) => `--accent:${x.accent};--accent-ink:${x.ink};--accent-soft:${x.soft};`;
  return `:root{${v(p.light)}}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${v(p.dark)}}}:root[data-theme="dark"]{${v(p.dark)}}`;
}

let mounted = 0;
const STYLE_ID = 'tenant-accent';
/** Apply the tenant accent at runtime. Only a validated #rrggbb value is ever written into the stylesheet. */
function useTenantAccent(accent: string | null | undefined) {
  useEffect(() => {
    mounted++;
    return () => { if (--mounted === 0) document.getElementById(STYLE_ID)?.remove(); };
  }, []);
  useEffect(() => {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!accent || !HEX.test(accent) || contrastWithWhite(accent) < MIN_CONTRAST) { el?.remove(); return; }
    if (!el) { el = document.createElement('style'); el.id = STYLE_ID; document.head.appendChild(el); }
    el.textContent = accentCss(accent.toLowerCase());
  }, [accent]);
}

/** Organization logo, or initials on the accent colour. Decorative by default (the name is shown next to it). */
export function LogoTile({ name, logoUrl, size = 32, alt = '' }: { name: string; logoUrl?: string | null; size?: number; alt?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [logoUrl]);
  if (logoUrl && !broken) return <img src={logoUrl} alt={alt} width={size} height={size} onError={() => setBroken(true)} style={{ width: size, height: size }} className="shrink-0 rounded-lg object-contain" />;
  return (
    <div style={{ width: size, height: size }} className={cx('flex shrink-0 items-center justify-center rounded-lg bg-accent font-semibold text-on-accent', size >= 40 ? 'text-[15px]' : 'text-[12px]')}
      role={alt ? 'img' : undefined} aria-label={alt || undefined} aria-hidden={alt ? undefined : true}>{initials(name) || '?'}</div>
  );
}

/** Sidebar brand mark. Also applies the tenant accent for the signed-in session. */
export function BrandMark() {
  const me = useMe();
  const b = useBranding();
  useTenantAccent(b.data?.accent);
  return <LogoTile name={b.data?.displayName ?? me.tenant.name} logoUrl={b.data?.logo?.url} />;
}
