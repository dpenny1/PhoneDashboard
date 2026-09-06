// ── CXone Auth — direct browser calls (no proxy) ─────────────────────────────
// Attempts ROPC login directly to CXone from the browser.
// Works if CXone allows CORS on their auth endpoint (common for enterprise APIs).

// Requests go through the local proxy (proxy.js) to avoid CORS.
// Run: node proxy.js   — then open the dashboard.
const CX_BASE = 'http://localhost:3000';

// ── Login ─────────────────────────────────────────────────────────────────────
// Save a token pasted directly from the CXone browser session
export function cxLogin(token) {
  if (!token) throw new Error('No token provided');
  saveCxTokens({ access_token: token, expires_in: 14400 }); // assume 4hr expiry
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
  // No refresh with pasted tokens — user re-pastes when expired
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
