// ── CXone Auth (via Cloudflare Worker proxy) ──────────────────────────────────
// All CXone API calls go through the worker to avoid CORS and hide credentials.

// Update this to your deployed Cloudflare Worker URL after deploying worker.js
export const WORKER_URL = 'https://rc-dashboard.YOUR_SUBDOMAIN.workers.dev';

// ── Login ─────────────────────────────────────────────────────────────────────
export async function cxLogin(username, password) {
  const resp = await fetch(`${WORKER_URL}/cx/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ username, password }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'Login failed' }));
    throw new Error(err.error || `CXone login failed (${resp.status})`);
  }

  const data = await resp.json();
  saveCxTokens(data);
  return data;
}

// ── Token storage ─────────────────────────────────────────────────────────────
function saveCxTokens(data) {
  const expiry = Date.now() + (data.expires_in || 3600) * 1000;
  localStorage.setItem('cx_access_token',  data.access_token);
  localStorage.setItem('cx_refresh_token', data.refresh_token || '');
  localStorage.setItem('cx_token_expiry',  expiry);
  if (data.agentInfo) localStorage.setItem('cx_agent_info', JSON.stringify(data.agentInfo));
}

export function getCxToken()     { return localStorage.getItem('cx_access_token'); }
export function getCxAgentInfo() { return JSON.parse(localStorage.getItem('cx_agent_info') || 'null'); }
export function cxIsLoggedIn()   { return !!getCxToken() && Date.now() < Number(localStorage.getItem('cx_token_expiry')); }
export function cxLogout()       { ['cx_access_token','cx_refresh_token','cx_token_expiry','cx_agent_info'].forEach(k => localStorage.removeItem(k)); }

// ── Auto refresh ──────────────────────────────────────────────────────────────
export async function cxRefreshIfNeeded() {
  const expiry  = Number(localStorage.getItem('cx_token_expiry') || 0);
  const refresh = localStorage.getItem('cx_refresh_token');
  if (!refresh || Date.now() < expiry - 5 * 60 * 1000) return;

  const resp = await fetch(`${WORKER_URL}/cx/refresh`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ refresh_token: refresh }),
  });
  if (resp.ok) saveCxTokens(await resp.json());
  else cxLogout();
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function cxWorkerFetch(path, opts = {}) {
  await cxRefreshIfNeeded();
  const token = getCxToken();
  if (!token) throw new Error('Not authenticated with CXone');
  const resp = await fetch(`${WORKER_URL}${path}`, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, ...opts.headers },
  });
  if (resp.status === 401) { cxLogout(); location.reload(); }
  if (!resp.ok) throw new Error(`CXone API error ${resp.status}`);
  return resp.json();
}

export async function fetchAgentStates()  { return cxWorkerFetch('/cx/agents'); }
export async function fetchQueueStats()   { return cxWorkerFetch('/cx/queues'); }

// ── Status sync: push CXone state → RC MVP ───────────────────────────────────
export async function syncStatusToRC(cxState, rcToken, rcExtensionId) {
  const resp = await fetch(`${WORKER_URL}/sync/status`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ cxState, rcToken, rcExtensionId }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.warn('Status sync failed:', err.error);
    return false;
  }
  return true;
}
