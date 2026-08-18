// ── CXone Auth — direct browser calls using a bearer token ───────────────────
// No proxy needed. Paste your CXone bearer token into the login screen.
// Tokens typically expire after 1–8 hours; you'll be prompted to re-enter it.

const CX_BASE = 'https://na1.nice-incontact.com';

// ── Token storage ─────────────────────────────────────────────────────────────
export function saveCxToken(token) {
  localStorage.setItem('cx_access_token', token);
  // We don't know expiry from a pasted token, so store a 4-hour window
  localStorage.setItem('cx_token_expiry', Date.now() + 4 * 60 * 60 * 1000);
}

export function getCxToken()   { return localStorage.getItem('cx_access_token'); }
export function cxIsLoggedIn() { return !!getCxToken() && Date.now() < Number(localStorage.getItem('cx_token_expiry') || 0); }
export function cxLogout()     { ['cx_access_token','cx_token_expiry','cx_agent_info'].forEach(k => localStorage.removeItem(k)); }

// ── Direct API calls ──────────────────────────────────────────────────────────
async function cxFetch(path, opts = {}) {
  const token = getCxToken();
  if (!token) throw new Error('No CXone token — please sign in again.');

  const resp = await fetch(`${CX_BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers },
  });

  if (resp.status === 401) {
    cxLogout();
    throw new Error('CXone token expired — please sign in again.');
  }
  if (!resp.ok) throw new Error(`CXone API error ${resp.status}`);
  return resp.json();
}

export async function fetchAgentStates() {
  return cxFetch('/inContactAPI/services/v28.0/agents/states?updatedSince=0');
}

export async function fetchQueueStats() {
  return cxFetch('/inContactAPI/services/v28.0/skills/summary?fields=skillId,skillName,contactsQueued,agentsAvailable,longestQueueDuration');
}

// ── Agent actions ─────────────────────────────────────────────────────────────
export async function sendAgentMessage(agentId, message) {
  return cxFetch(`/inContactAPI/services/v28.0/agents/${agentId}/message`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

export async function logoutAgent(agentId) {
  return cxFetch(`/inContactAPI/services/v28.0/agents/${agentId}/logout`, { method: 'POST' });
}

// ── Kept for compatibility (no-op — token is pasted, not via ROPC) ────────────
export async function cxRefreshIfNeeded() {}
export function getCxAgentInfo() { return null; }
