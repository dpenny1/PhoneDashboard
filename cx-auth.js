// ── CXone Auth — direct browser calls (no proxy) ─────────────────────────────
// Attempts ROPC login directly to CXone from the browser.
// Works if CXone allows CORS on their auth endpoint (common for enterprise APIs).

const CX_BASE = 'https://na1.nice-incontact.com';

// Read the claims out of a JWT without verifying it — we only want to tell the
// user what they pasted, never to trust it. CXone does the actual validating.
function readJwt(t) {
  try {
    const body = t.split('.')[1];
    if (!body) return null;
    return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
  } catch (e) { return null; }
}

// ── Login ─────────────────────────────────────────────────────────────────────
// This box wants the bearer token from a signed-in CXone browser session — a
// JWT beginning "eyJ". An Access Key created in CXone admin (whether you paste
// the key ID or the secret) is a different kind of credential: it has to be
// exchanged for a bearer token first, and pasting it here only ever earns a 401.
export function cxLogin(token) {
  if (!token) throw new Error('No token provided');
  const t = String(token).trim();

  if (!t.startsWith('eyJ')) {
    throw new Error(
      'That is not a CXone bearer token. An Access Key ID or Key Secret from ' +
      'CXone admin will not work here — CXone rejects it with 401. Use the ' +
      '"Get token from CXone" helper, which copies the token out of your ' +
      'signed-in CXone tab. It is a long value starting with "eyJ".');
  }

  const claims = readJwt(t);
  if (claims && claims.exp && claims.exp * 1000 < Date.now()) {
    throw new Error('That token expired ' + new Date(claims.exp * 1000).toLocaleString() +
                    '. Grab a fresh one with the helper — CXone session tokens last a few hours.');
  }

  localStorage.setItem('cx_access_token', t);
  // Knowing the expiry up front lets the dashboard warn before calls start failing
  if (claims && claims.exp) localStorage.setItem('cx_token_expiry', String(claims.exp * 1000));
  else localStorage.removeItem('cx_token_expiry');
}

// When does the stored token run out? null if unknown.
export function cxTokenExpiry() {
  const v = Number(localStorage.getItem('cx_token_expiry') || 0);
  return v > 0 ? v : null;
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
    resp = await fetch(`${CX_BASE}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers },
    });
  } catch (e) {
    // fetch only rejects for network-level failures. From a browser on another
    // origin that almost always means CXone refused the cross-origin request,
    // which is indistinguishable from being offline at this layer.
    console.error('CXone request to ' + CX_BASE + path + ' never completed:', e);
    throw new Error('CXone unreachable from the browser (blocked or offline) — ' + e.message);
  }

  if (resp.status === 401) { cxLogout(); throw new Error('CXone token expired — use the Get Token helper to refresh it.'); }
  if (resp.status === 403) throw new Error('CXone refused the request (403) — the token lacks permission for this call.');
  if (!resp.ok) throw new Error(`CXone API error ${resp.status}`);
  return resp.json();
}

export async function fetchAgentStates() {
  return cxFetch('/inContactAPI/services/v28.0/agents/states?updatedSince=0');
}

export async function fetchQueueStats() {
  return cxFetch('/inContactAPI/services/v28.0/skills/summary?fields=skillId,skillName,contactsQueued,agentsAvailable,longestQueueDuration');
}

// Set CXone agent state (Available, Break, Lunch, Training, etc.)
export async function setAgentState(agentId, state) {
  return cxFetch(`/inContactAPI/services/v28.0/agents/${agentId}/state`, {
    method: 'POST',
    body: JSON.stringify({ state }),
  });
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
