import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

/**
 * SSRF-guarded HTTPS fetch for user-supplied calendar addresses.
 * https only on the standard port, no embedded credentials, every hop (including redirects) is DNS-resolved and refused
 * when any address is private, loopback, link-local, CGNAT, multicast, reserved or a cloud metadata endpoint. The socket is
 * pinned to the validated address (no DNS-rebinding window). Max 3 redirects, 15 s total, 5 MB body.
 */
export class FetchGuardError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface FetchResponse { status: number; header(name: string): string | undefined; body: AsyncIterable<Uint8Array>; cancel(): void }
export interface FetchDeps {
  resolve(host: string): Promise<string[]>;
  /** Perform one GET to `url`, connecting only to the already-validated `address`. */
  request(url: URL, o: { headers: Record<string, string>; address: string; signal: AbortSignal }): Promise<FetchResponse>;
}
export const LIMITS = { maxBytes: 5 * 1024 * 1024, timeoutMs: 15_000, maxRedirects: 3 };

const v4num = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ['168.63.129.16', 32], // Azure host/metadata endpoint (outside private ranges)
];
function v4Public(ip: string) {
  const n = v4num(ip);
  return !V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4num(base) / 2 ** (32 - bits)));
}
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const tail4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail4) { const n = v4num(tail4[2]); s = `${tail4[1]}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`; }
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [], rest = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - rest.length)).fill('0'), ...rest] : head;
  const out = groups.map((g) => parseInt(g, 16));
  return out.length === 8 && out.every((g) => g >= 0 && g <= 0xffff) ? out : null;
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv4(ip)) return v4Public(ip);
  if (!net.isIPv6(ip)) return false;
  const g = v6Groups(ip);
  if (!g) return false;
  const embedded4 = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Public(embedded4()); // IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Public(embedded4()); // NAT64
  if ((g[0] & 0xe000) !== 0x2000) return false; // only 2000::/3 is global unicast (excludes ::1, fc00::/7, fe80::/10, ff00::/8, ...)
  if (g[0] === 0x2001 && g[1] < 0x200) return false; // 2001::/23 protocol assignments incl. Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // documentation
  if (g[0] === 0x2002) return false; // 6to4 (embeds arbitrary IPv4)
  return true;
}

const BLOCKED_HOST = /(^localhost$|\.localhost$|\.local$|\.internal$|\.home\.arpa$|^metadata$|^metadata\.)/i;

/** Syntactic checks for one URL (no network). Throws FetchGuardError. */
export function validateUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new FetchGuardError('bad_url', 'That is not a valid web address'); }
  if (raw.length > 2048) throw new FetchGuardError('bad_url', 'That address is too long');
  if (u.protocol !== 'https:') throw new FetchGuardError('not_https', 'Only https:// addresses are allowed');
  if (u.username || u.password) throw new FetchGuardError('credentials', 'Addresses with an embedded user name or password are not allowed');
  if (u.port && u.port !== '443') throw new FetchGuardError('port', 'Only the standard https port is allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { if (!isPublicAddress(host)) throw privateErr(host); }
  else if (BLOCKED_HOST.test(host) || !host.includes('.')) throw privateErr(host);
  return u;
}
const privateErr = (host: string) => new FetchGuardError('private_address', `${host} is a private, local or reserved address. Only public internet addresses are allowed.`);

async function resolvePublic(u: URL, deps: FetchDeps) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return host;
  let addrs: string[];
  try { addrs = await deps.resolve(host); } catch { throw new FetchGuardError('dns', `Could not find the server ${host}`); }
  if (!addrs.length) throw new FetchGuardError('dns', `Could not find the server ${host}`);
  if (addrs.some((a) => !isPublicAddress(a))) throw privateErr(host);
  return addrs[0];
}

/** Validate a user-supplied address including DNS (all resolved addresses must be public). */
export async function assertPublicUrl(raw: string, deps: FetchDeps = defaultDeps) {
  const u = validateUrl(raw);
  await resolvePublic(u, deps);
  return u;
}

export type GuardedResult =
  | { status: 'ok'; text: string; etag: string | null; lastModified: string | null; finalUrl: string }
  | { status: 'not_modified' };

export async function guardedFetch(raw: string, opts: { headers?: Record<string, string>; deps?: FetchDeps; limits?: Partial<typeof LIMITS> } = {}): Promise<GuardedResult> {
  const deps = opts.deps ?? defaultDeps;
  const lim = { ...LIMITS, ...opts.limits };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), lim.timeoutMs);
  const aborted = new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }));
  aborted.catch(() => {});
  const headers = { 'user-agent': 'TaskTracking-CalendarSync/1.0', accept: 'text/calendar, text/plain;q=0.8, */*;q=0.1', 'accept-encoding': 'identity', ...opts.headers };
  try {
    let url = validateUrl(raw);
    for (let hop = 0; ; hop++) {
      const address = await Promise.race([resolvePublic(url, deps), aborted]);
      const res = await Promise.race([deps.request(url, { headers, address, signal: ac.signal }), aborted]);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        res.cancel();
        if (hop >= lim.maxRedirects) throw new FetchGuardError('too_many_redirects', `More than ${lim.maxRedirects} redirects`);
        const loc = res.header('location');
        if (!loc) throw new FetchGuardError('http_status', `Redirect (HTTP ${res.status}) without a location`);
        url = validateUrl(new URL(loc, url).toString());
        continue;
      }
      if (res.status === 304) { res.cancel(); return { status: 'not_modified' }; }
      if (res.status !== 200) { res.cancel(); throw new FetchGuardError('http_status', `The calendar server answered HTTP ${res.status}`); }
      const tooLarge = () => new FetchGuardError('too_large', `The calendar is larger than ${Math.round(lim.maxBytes / 1048576)} MB`);
      if (Number(res.header('content-length') ?? 0) > lim.maxBytes) { res.cancel(); throw tooLarge(); }
      const chunks: Buffer[] = []; let total = 0;
      for await (const c of res.body) {
        total += c.length;
        if (total > lim.maxBytes) { res.cancel(); throw tooLarge(); }
        chunks.push(Buffer.from(c));
      }
      return { status: 'ok', text: Buffer.concat(chunks).toString('utf8'), etag: res.header('etag') ?? null, lastModified: res.header('last-modified') ?? null, finalUrl: url.toString() };
    }
  } catch (e: any) {
    if (e instanceof FetchGuardError) throw e;
    if (ac.signal.aborted) throw new FetchGuardError('timeout', `No complete response within ${Math.round(lim.timeoutMs / 1000)} s`);
    throw new FetchGuardError('network', `Could not fetch the calendar (${e?.code ?? e?.message ?? 'network error'})`);
  } finally {
    clearTimeout(timer);
  }
}

export const defaultDeps: FetchDeps = {
  resolve: async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((r) => r.address),
  request: (url, o) => new Promise((resolve, reject) => {
    const family = net.isIPv6(o.address) ? 6 : 4;
    const req = https.request(url, {
      method: 'GET', headers: o.headers, signal: o.signal, agent: false,
      ...(net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? {} : { servername: url.hostname }),
      // Pin the connection to the validated address: no second DNS lookup can redirect it elsewhere.
      lookup: ((_h: string, opts: any, cb: any) => (opts?.all ? cb(null, [{ address: o.address, family }]) : cb(null, o.address, family))) as any,
    });
    req.on('response', (res) => resolve({
      status: res.statusCode ?? 0,
      header: (n) => { const v = res.headers[n.toLowerCase()]; return Array.isArray(v) ? v[0] : v; },
      body: res, cancel: () => res.destroy(),
    }));
    req.on('error', reject);
    req.end();
  }),
};
