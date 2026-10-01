import type { Db } from '../../lib/db.js';
import { one } from '../../lib/db.js';
import { readStored } from '../../lib/storage.js';

// ---------- Colour contrast (WCAG 2.x relative luminance) ----------
export const HEX = /^#[0-9a-f]{6}$/;
export const DEFAULT_ACCENT = '#256abf';
export const MIN_CONTRAST = 4.5;

const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const luminance = (hex: string) => { const [r, g, b] = rgb(hex).map(channel); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
export const contrastWithWhite = (hex: string) => contrast(hex, '#ffffff');

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl(h: number, s: number, l: number) {
  const f = (n: number) => {
    const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
/** Nearest darker shade (same hue and saturation, lower lightness) that keeps white text at >= 4.5:1. */
export function nearestAccessibleShade(hex: string) {
  if (contrastWithWhite(hex) >= MIN_CONTRAST) return hex;
  const [h, s, l] = toHsl(hex);
  for (let x = l; x >= 0; x -= 0.0025) {
    const c = fromHsl(h, s, x);
    if (contrastWithWhite(c) >= MIN_CONTRAST) return c;
  }
  return '#000000';
}

// ---------- Logo validation ----------
export const LOGO_MAX_BYTES = 200 * 1024;
export type LogoMime = 'image/png' | 'image/jpeg' | 'image/svg+xml';

const SVG_ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath', 'defs',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'title', 'desc', 'use', 'symbol', 'pattern', 'style', 'metadata', 'filter',
  'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix', 'feflood', 'fecomposite', 'femerge', 'femergenode', 'fedropshadow']);
// Inert editor metadata namespaces (Inkscape, RDF licence blocks). A prefix is only inert while it is bound to its real namespace:
// xmlns:dc="http://www.w3.org/2000/svg" would turn <dc:script> into a live SVG script element.
const SVG_META_PREFIXES = new Set(['sodipodi', 'inkscape', 'rdf', 'cc', 'dc']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const NS_BINDINGS: Record<string, string[]> = {
  sodipodi: ['http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd'], inkscape: ['http://www.inkscape.org/namespaces/inkscape'],
  rdf: ['http://www.w3.org/1999/02/22-rdf-syntax-ns#'], cc: ['http://creativecommons.org/ns#', 'http://web.resource.org/cc/'], dc: ['http://purl.org/dc/elements/1.1/'],
  svg: [SVG_NS], xlink: ['http://www.w3.org/1999/xlink'],
};
const decodeEntities = (s: string) => s
  .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) % 0x110000))
  .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d) % 0x110000));
/** Checked after XML entity and CSS escape decoding (u\72l( is url(), with whitespace removed (stricter than CSS itself). */
const unsafeCss = (css: string) => {
  const c = decodeEntities(css)
    .replace(/\\([0-9a-f]{1,6})[ \t\r\n\f]?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) % 0x110000))
    .replace(/\\([\s\S])/g, '$1').replace(/\s+/g, '').toLowerCase();
  return /@import|expression\(|javascript:|behavior:|-moz-binding|image-set\(/.test(c) || /url\((?!['"]?#)/.test(c);
};

// One left-to-right pass, as an XML parser reads it: comment, CDATA, processing instruction, declaration, tag, or a stray "<" (malformed).
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!|<(\/?)([A-Za-z_][\w:.-]*)((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>|</g;
const ATTR = /([^\s=/>"']+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g;
const NOT_SVG = 'The file is not a valid SVG.';
const NO_ROOT = 'The file is not a valid SVG (it must start with an <svg> element).';
const BAD_CSS = 'SVG styles may not import or reference external resources.';

/** Returns a reason when the SVG is unsafe to serve; null when it only contains inert drawing markup. */
export function svgProblem(text: string): string | null {
  if (text.includes('\u0000')) return NOT_SVG;
  const enc = /^\uFEFF?\s*<\?xml\s[^?]*?encoding\s*=\s*["']([^"']*)["']/i.exec(text);
  if (enc && !/^utf-?8$/i.test(enc[1])) return 'SVG files must be UTF-8 encoded.';
  let root = false, inStyle = false, css = '', last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const [tok, cdata, close, rawName, attrs] = m;
    if (inStyle) css += text.slice(last, m.index);
    last = m.index! + tok.length;
    if (tok.startsWith('<!--')) continue;
    if (cdata !== undefined) { if (inStyle) css += cdata; continue; }
    if (tok.startsWith('<?')) {
      if (!/^<\?xml\s/i.test(tok) || text.slice(0, m.index).replace(/^\uFEFF/, '').trim()) return 'SVG processing instructions (such as stylesheets) are not accepted.';
      continue;
    }
    if (tok === '<!') return 'SVG files with DOCTYPE or ENTITY declarations are not accepted.';
    if (rawName === undefined) return NOT_SVG;
    const name = rawName.toLowerCase();
    if (close) { if (attrs.trim()) return NOT_SVG; if (name === 'style') inStyle = false; continue; }
    if (!root && name !== 'svg') return NO_ROOT;
    root = true;
    const prefix = name.includes(':') ? name.split(':')[0] : null;
    if (prefix ? !SVG_META_PREFIXES.has(prefix) : !SVG_ELEMENTS.has(name)) return `SVG element <${rawName}> is not allowed in a logo (scripts, embedded content and links are rejected).`;
    if (!['', '/'].includes(attrs.replace(ATTR, '').trim())) return NOT_SVG;
    for (const [, an, dq, sq] of attrs.matchAll(ATTR)) {
      const attr = an.toLowerCase(), value = dq ?? sq ?? '';
      const v = decodeEntities(value).replace(/[\s\u0000-\u001f]/g, '').toLowerCase();
      const bound = attr === 'xmlns' ? [SVG_NS] : attr.startsWith('xmlns:') ? NS_BINDINGS[attr.slice(6)] : undefined;
      if (bound && !bound.includes(value.trim())) return 'SVG namespace declarations may only use the SVG namespace and inert editor metadata.';
      if (attr.startsWith('on')) return 'SVG event handler attributes (scripts) are not allowed.';
      if (/(^|:)href$/.test(attr) && !v.startsWith('#')) return 'SVG links to other files or URLs are not allowed in a logo.';
      if (/javascript:|vbscript:|data:/.test(v)) return 'SVG attributes may not contain script or data URLs.';
      if (unsafeCss(value)) return BAD_CSS;
    }
    if (name === 'style' && !attrs.trimEnd().endsWith('/')) inStyle = true;
  }
  if (!root) return NO_ROOT;
  if (inStyle) css += text.slice(last);
  return unsafeCss(css) ? BAD_CSS : null;
}

/** Identify the logo by content (never trust the declared type) and validate it. */
export function validateLogo(buf: Buffer): { mime: LogoMime } | { error: string } {
  if (!buf.length) return { error: 'The file is empty.' };
  if (buf.length > LOGO_MAX_BYTES) return { error: 'Logo must be 200 KB or smaller.' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return { error: 'The PNG file is damaged.' };
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (!w || !h || w > 4096 || h > 4096) return { error: 'PNG logos must be at most 4096 x 4096 pixels.' };
    return { mime: 'image/png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg' };
  const text = buf.toString('utf8');
  if (/^﻿?\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) {
    const problem = svgProblem(text);
    return problem ? { error: problem } : { mime: 'image/svg+xml' };
  }
  return { error: 'Upload a PNG, SVG or JPEG image.' };
}

// ---------- Tenant branding ----------
export interface Branding { name: string; accent: string | null; logoFileId: string | null; logoMime: string | null; weeklyDrafts: boolean; version: number; updatedAt: string | null }

export async function loadBranding(db: Db, tenantId: string): Promise<Branding> {
  const r = await one(db, `select t.name, b.accent, b.logo_file_id, f.mime logo_mime, coalesce(b.weekly_drafts, false) weekly_drafts, coalesce(b.version, 0) version, b.updated_at
    from tenants t left join tenant_branding b on b.tenant_id = t.id left join stored_files f on f.id = b.logo_file_id where t.id = $1`, [tenantId]);
  return { name: r.name, accent: r.accent, logoFileId: r.logo_file_id, logoMime: r.logo_mime, weeklyDrafts: r.weekly_drafts, version: r.version, updatedAt: r.updated_at };
}

export interface PdfBrand { name: string; accent: string; logo: Buffer | null }
/** Organization name, accent and (raster) logo for PDF headers. SVG logos are not embedded in PDFs; the name is always shown. */
export async function loadPdfBrand(db: Db, tenantId: string): Promise<PdfBrand> {
  const b = await loadBranding(db, tenantId);
  let logo: Buffer | null = null;
  if (b.logoFileId && (b.logoMime === 'image/png' || b.logoMime === 'image/jpeg')) {
    const f = await one(db, `select storage_key, sha256 from stored_files where id = $1`, [b.logoFileId]);
    logo = f ? await readStored(f).catch(() => null) : null;
  }
  return { name: b.name, accent: b.accent ?? DEFAULT_ACCENT, logo };
}

/** Draw the organization header at the top of the current PDF page. Never throws: a broken image falls back to the name. */
export function drawPdfBrandHeader(doc: PDFKit.PDFDocument, brand: PdfBrand) {
  const x = doc.page.margins.left, y = doc.page.margins.top, width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let textX = x;
  if (brand.logo) {
    try {
      // openImage is public pdfkit API (missing from @types/pdfkit).
      const img = (doc as unknown as { openImage(b: Buffer): { width: number; height: number } }).openImage(brand.logo), scale = Math.min(96 / img.width, 32 / img.height);
      doc.image(brand.logo, x, y + (32 - img.height * scale) / 2, { width: img.width * scale, height: img.height * scale });
      textX = x + img.width * scale + 10;
    } catch { /* unsupported image: name only */ }
  }
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text(brand.name, textX, y + 9, { width: width - (textX - x), lineBreak: false, ellipsis: true });
  doc.moveTo(x, y + 40).lineTo(x + width, y + 40).lineWidth(1.5).strokeColor(brand.accent).stroke();
  doc.x = x; doc.y = y + 52;
}
