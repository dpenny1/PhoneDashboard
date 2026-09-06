// ── CXone Auth — direct browser calls (no proxy) ─────────────────────────────
// Attempts ROPC login directly to CXone from the browser.
// Works if CXone allows CORS on their auth endpoint (common for enterprise APIs).

const CX_BASE = 'https://na1.nice-incontact.com';

// ── Login ─────────────────────────────────────────────────────────────────────
// Save a token pasted directly from the CXone browser session
export function cxLogin(token) {
  if (!token) throw new Error('No token provided');
  localStorage.setItem('cx_access_token', token);
  // No expiry stored — token persists until API returns 401, then user re-pastes
  localStorage.removeItem('cx_token_expiry');
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
export function cxIsLoggedIn()   { return !!getCxToken(); } // stays logged in until token is cleared
export function cxLogout()       { ['cx_access_token','cx_token_expiry'].forEach(k => localStorage.removeItem(k)); }

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

  if (resp.status === 401) { cxLogout(); throw new Error('CXone token expired — use the Get Token helper to refresh it.'); }
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
