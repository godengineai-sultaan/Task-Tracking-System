export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

/**
 * Product focus sent with every request ('all' = no focus, 'none' = company-wide work, or a product id). The server applies it only
 * to list views (GET on its FOCUS_PATHS); single records, personal pages and writes ignore it. Set by the PortfolioProvider.
 */
let productFocus = 'all';
let focusRejected: (() => void) | null = null;
export function setApiProductFocus(focus: string) { productFocus = focus || 'all'; }
export function getApiProductFocus() { return productFocus; }
/** Called when the server refuses the focus (the product left this person's scope); the request is retried without it. */
export function onProductFocusRejected(fn: (() => void) | null) { focusRejected = fn; }

async function request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: { 'x-requested-with': 'fetch', ...(productFocus !== 'all' ? { 'x-product-focus': productFocus } : {}) } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); (init.headers as any)['content-type'] = 'application/json'; }
  let res: Response;
  try { res = await fetch(path, init); } catch { throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and try again.'); }
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    if (res.status === 403 && data?.error === 'focus_out_of_scope' && retry) {
      productFocus = 'all'; focusRejected?.();
      return request<T>(method, path, body, false);
    }
    if (res.status === 401 && !path.startsWith('/api/auth/') && !location.pathname.startsWith('/login') && !location.pathname.startsWith('/join')) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    }
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `Request failed (${res.status})`, data?.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T = any>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
  patch: <T = any>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}),
  del: <T = any>(p: string, b?: unknown) => request<T>('DELETE', p, b ?? {}),
};

export function qs(o: Record<string, string | number | undefined | null | boolean>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
