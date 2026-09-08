// ── CXone Auth — direct browser calls (no proxy) ─────────────────────────────
// Token is pasted from an authenticated CXone browser session and kept in
// localStorage. CXone allows CORS from this origin (verified: it returns
// Access-Control-Allow-Origin for https://dpenny1.github.io), so no proxy
// is required.
//
// IMPORTANT — two different hosts, easy to confuse:
//   Auth / token  →  na1.nice-incontact.com      (hyphen, no prefix)
//   Data calls    →  api-na1.niceincontact.com   (api- prefix, NO hyphen)
// Sending data calls to the auth host returns 404, which surfaces in the
// browser as a CORS error because the gateway refuses the preflight for a
// path it cannot route.
const CX_AUTH_BASE = 'https://na1.nice-incontact.com';
const CX_API_BASE  = 'https://api-na1.niceincontact.com';

// API version. v30.0 verified working against /agents/states.
// If a call starts returning 404, try 'v28.0' or 'v31.0' here first.
const CX_API_VERSION = 'v30.0';

// Build a versioned inContactAPI path.
const api = (p) => `/inContactAPI/services/${CX_API_VERSION}${p}`;

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
  let resp;
  try {
    resp = await fetch(`${CX_API_BASE}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers },
    });
  } catch (e) {
    // fetch only rejects for network-level failures. From a browser on another
    // origin that almost always means CXone refused the cross-origin request,
    // which is indistinguishable from being offline at this layer.
    console.error('CXone request to ' + CX_API_BASE + path + ' never completed:', e);
    throw new Error('CXone unreachable from the browser (blocked or offline) — ' + e.message);
  }
  if (resp.status === 401) { cxLogout(); throw new Error('CXone token expired — use the Get Token helper to refresh it.'); }
  if (resp.status === 403) throw new Error('CXone refused the request (403) — the token lacks permission for this call.');
  if (resp.status === 404) throw new Error(`CXone endpoint not found (404) at ${path} — check CX_API_VERSION in cx-auth.js.`);
  if (!resp.ok) throw new Error(`CXone API error ${resp.status}`);
  return resp.json();
}

export async function fetchAgentStates() {
  return cxFetch(api('/agents/states?updatedSince=0'));
}

export async function fetchQueueStats() {
  return cxFetch(api('/skills/summary?fields=skillId,skillName,contactsQueued,agentsAvailable,longestQueueDuration'));
}

// Set CXone agent state (Available, Break, Lunch, Training, etc.)
export async function setAgentState(agentId, state) {
  return cxFetch(api(`/agents/${agentId}/state`), {
    method: 'POST',
    body: JSON.stringify({ state }),
  });
}

export async function sendAgentMessage(agentId, message) {
  return cxFetch(api(`/agents/${agentId}/message`), {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

export async function logoutAgent(agentId) {
  return cxFetch(api(`/agents/${agentId}/logout`), { method: 'POST' });
}
