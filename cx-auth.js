// ── CXone Auth — direct browser calls (no proxy) ─────────────────────────────
// Attempts ROPC login directly to CXone from the browser.
// Works if CXone allows CORS on their auth endpoint (common for enterprise APIs).

// Requests go through the local proxy (proxy.js) to avoid CORS.
// Run: node proxy.js   — then open the dashboard.
const CX_BASE = 'http://localhost:3000';

// ── Login ─────────────────────────────────────────────────────────────────────
export async function cxLogin(username, password) {
  const resp = await fetch(`${CX_BASE}/authentication/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', username, password, scope: 'AgentApi' }),
  });

  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(e.error_description || `CXone login failed (${resp.status})`);
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
}

export function getCxToken()     { return localStorage.getItem('cx_access_token'); }
export function getCxAgentInfo() { return null; }
export function cxIsLoggedIn()   { return !!getCxToken() && Date.now() < Number(localStorage.getItem('cx_token_expiry') || 0); }
export function cxLogout()       { ['cx_access_token','cx_refresh_token','cx_token_expiry'].forEach(k => localStorage.removeItem(k)); }

// ── Auto refresh ──────────────────────────────────────────────────────────────
export async function cxRefreshIfNeeded() {
  const expiry  = Number(localStorage.getItem('cx_token_expiry') || 0);
  const refresh = localStorage.getItem('cx_refresh_token');
  if (!refresh || Date.now() < expiry - 5 * 60 * 1000) return;

  const resp = await fetch(`${CX_BASE}/authentication/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
  });
  if (resp.ok) saveCxTokens(await resp.json());
  else cxLogout();
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function cxFetch(path, opts = {}) {
  await cxRefreshIfNeeded();
  const token = getCxToken();
  if (!token) throw new Error('Not authenticated with CXone');

  const resp = await fetch(`${CX_BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers },
  });

  if (resp.status === 401) { cxLogout(); throw new Error('CXone session expired — please sign in again.'); }
  if (!resp.ok) throw new Error(`CXone API error ${resp.status}`);
  return resp.json();
}

export async function fetchAgentStates() {
  return cxFetch('/inContactAPI/services/v28.0/agents/states?updatedSince=0');
}

export async function fetchQueueStats() {
  return cxFetch('/inContactAPI/services/v28.0/skills/summary?fields=skillId,skillName,contactsQueued,agentsAvailable,longestQueueDuration');
}

export async function sendAgentMessage(agentId, message) {
  return cxFetch(`/inContactAPI/services/v28.0/agents/${agentId}/message`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

export async function logoutAgent(agentId) {
  return cxFetch(`/inContactAPI/services/v28.0/agents/${agentId}/logout`, { method: 'POST' });
}
