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
export function cxIsLoggedIn()   { return !!getCxToken(); }
export function cxLogout()       { ['cx_access_token','cx_token_expiry'].forEach(k => localStorage.removeItem(k)); }

// ── Why the token is pasted by hand ──────────────────────────────────────────
// A CXone Access Key (ID + Secret) can be exchanged for a bearer token, which
// would let the dashboard re-authenticate itself. That exchange happens on
// na1.nice-incontact.com, which sends no CORS headers, so a browser cannot make
// the call — every shape of it fails at the network layer before CXone ever
// answers. Doing it from a server was ruled out (2026-09-09): no Cloudflare, and
// the internal FIN Dashboard box is off limits too.
//
// So the token comes out of a signed-in CXone tab and is pasted in here. It
// lasts about an hour. cx-token-helper.html grabs it in one click.
//
// If a server ever does become available, the missing piece is one endpoint that
// holds the access key and returns { access_token, expires_in } — everything
// below already works off localStorage.cx_access_token and would not change.

// ── API calls ─────────────────────────────────────────────────────────────────
async function cxFetch(path, opts = {}) {
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
  if (!resp.ok) {
    // CXone explains itself in the body. Dropping it leaves a bare status code
    // and nothing to act on, so carry it into the message and the console.
    const detail = (await resp.text().catch(() => '')).slice(0, 400);
    console.error(`CXone ${resp.status} on ${CX_API_BASE}${path}:`, detail || '(empty body)');

    if (resp.status === 401) {
      cxLogout();
      throw new Error('CXone token expired — use the Get Token helper to refresh it.' +
                      (detail ? ' ' + detail : ''));
    }
    if (resp.status === 403) {
      throw new Error('CXone refused the request (403) — the token lacks permission for this call.' +
                      (detail ? ' ' + detail : ''));
    }
    if (resp.status === 404) {
      throw new Error(`CXone endpoint not found (404) at ${path} — check CX_API_VERSION in cx-auth.js.` +
                      (detail ? ' ' + detail : ''));
    }
    if (resp.status === 400) {
      throw new Error('CXone rejected the request itself (400) — the token was accepted, so this is a ' +
                      'malformed call rather than an auth problem.' + (detail ? ' ' + detail : ''));
    }
    throw new Error(`CXone API error ${resp.status}` + (detail ? ` — ${detail}` : ''));
  }
  return resp.json();
}

// updatedSince has bitten us twice: "InvalidUpdatedSince" for a bad format
// (updatedSince=0), then "InvalidDateRange" for 2020-01-01 — CXone caps how far
// back you may ask. So the candidates are recent windows, newest-acceptable
// first, and each is computed fresh at call time rather than being a fixed date.
//
// A 24h window is ample for a live board: anyone currently logged in has changed
// state within it, and anyone who hasn't reads Logged Out anyway.
const hoursAgo = (h, withZone = true) => {
  const iso = new Date(Date.now() - h * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return withZone ? iso : iso.replace(/Z$/, '');
};

const CX_SINCE_CANDIDATES = [
  { label: '24h',         build: () => hoursAgo(24) },
  { label: '12h',         build: () => hoursAgo(12) },
  { label: '1h',          build: () => hoursAgo(1) },
  { label: '24h no zone', build: () => hoursAgo(24, false) },
  { label: 'omitted',     build: () => null },
];
const CX_SINCE_KEY = 'cx_updated_since_choice';

// Both complaints mean "try a different updatedSince", not "give up".
const RETRYABLE = /InvalidUpdatedSince|InvalidDateRange/i;

function statesPath(since) {
  return api('/agents/states' + (since ? '?updatedSince=' + encodeURIComponent(since) : ''));
}

export async function fetchAgentStates() {
  // Once we know which window this tenant accepts, go straight to it.
  const known = Number(localStorage.getItem(CX_SINCE_KEY));
  if (CX_SINCE_CANDIDATES[known]) {
    try {
      return await cxFetch(statesPath(CX_SINCE_CANDIDATES[known].build()));
    } catch (e) {
      if (!RETRYABLE.test(e.message)) throw e;
      localStorage.removeItem(CX_SINCE_KEY);   // stopped working; probe again
    }
  }

  let last;
  for (let i = 0; i < CX_SINCE_CANDIDATES.length; i++) {
    const c = CX_SINCE_CANDIDATES[i];
    const since = c.build();
    try {
      const data = await cxFetch(statesPath(since));
      localStorage.setItem(CX_SINCE_KEY, String(i));
      console.info('CXone accepted updatedSince ' + c.label +
                   ' (' + (since || 'omitted') + ') — remembered for next time.');
      return data;
    } catch (e) {
      if (!RETRYABLE.test(e.message)) throw e;   // a real error — stop probing
      console.warn('CXone rejected updatedSince ' + c.label + ': ' + e.message);
      last = e;
    }
  }
  throw new Error('CXone rejected every updatedSince window tried (' +
                  CX_SINCE_CANDIDATES.map(c => c.label).join(', ') +
                  '). Last response: ' + (last ? last.message : 'none'));
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
