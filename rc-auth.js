// ── RingCentral OAuth (PKCE) ──────────────────────────────────────────────────
const RC_CLIENT_ID   = 'dwLXTnila2ydldmUAljjhn';
const RC_REDIRECT    = 'https://dpenny1.github.io/PhoneDashboard/callback.html';
const RC_AUTH_URL    = 'https://platform.ringcentral.com/restapi/oauth/authorize';
const RC_TOKEN_URL   = 'https://platform.ringcentral.com/restapi/oauth/token';
const RC_API_BASE    = 'https://platform.ringcentral.com/restapi/v1.0';
const RC_SCOPES      = 'ReadPresence EditPresence ReadCallLog ReadAccounts EditExtensions';

// ── PKCE helpers ──
async function generatePKCE() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}
function base64url(buffer) {
  return btoa(String.fromCharCode(...buffer)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── Login ──
export async function rcLogin() {
  const { verifier, challenge } = await generatePKCE();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('rc_pkce_verifier', verifier);
  sessionStorage.setItem('rc_oauth_state', state);
  sessionStorage.setItem('rc_return_url', location.href);

  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             RC_CLIENT_ID,
    redirect_uri:          RC_REDIRECT,
    scope:                 RC_SCOPES,
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });
  location.href = RC_AUTH_URL + '?' + params;
}

// ── Token exchange (called from callback.html) ──
export async function rcExchangeCode(code, state) {
  const storedState   = sessionStorage.getItem('rc_oauth_state');
  const verifier      = sessionStorage.getItem('rc_pkce_verifier');
  const returnUrl     = sessionStorage.getItem('rc_return_url') || '/';

  if (state !== storedState) throw new Error('OAuth state mismatch');

  const resp = await fetch(RC_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     RC_CLIENT_ID,
      redirect_uri:  RC_REDIRECT,
      code,
      code_verifier: verifier,
    }),
  });
  if (!resp.ok) throw new Error('Token exchange failed: ' + await resp.text());

  const tokens = await resp.json();
  saveTokens(tokens);
  sessionStorage.removeItem('rc_pkce_verifier');
  sessionStorage.removeItem('rc_oauth_state');
  return returnUrl;
}

// ── Token storage ──
function saveTokens(tokens) {
  const expiry = Date.now() + tokens.expires_in * 1000;
  localStorage.setItem('rc_access_token',        tokens.access_token);
  localStorage.setItem('rc_refresh_token',       tokens.refresh_token || '');
  localStorage.setItem('rc_token_expiry',        expiry);
}

export function getAccessToken()  { return localStorage.getItem('rc_access_token'); }
export function isLoggedIn()      { return !!getAccessToken() && Date.now() < Number(localStorage.getItem('rc_token_expiry')); }
export function rcLogout()        { ['rc_access_token','rc_refresh_token','rc_token_expiry'].forEach(k => localStorage.removeItem(k)); }

// ── Auto token refresh ──
export async function rcRefreshIfNeeded() {
  const expiry  = Number(localStorage.getItem('rc_token_expiry') || 0);
  const refresh = localStorage.getItem('rc_refresh_token');
  if (!refresh || Date.now() < expiry - 5 * 60 * 1000) return; // 5 min buffer

  const resp = await fetch(RC_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     RC_CLIENT_ID,
      refresh_token: refresh,
    }),
  });
  if (resp.ok) saveTokens(await resp.json());
}

// ── API helper ──
export async function rcFetch(path, opts = {}) {
  await rcRefreshIfNeeded();
  const token = getAccessToken();
  if (!token) throw new Error('Not authenticated');
  const resp = await fetch(RC_API_BASE + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, ...opts.headers },
  });
  if (resp.status === 401) { rcLogout(); location.reload(); }
  if (!resp.ok) throw new Error(`RC API error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ── Data fetchers ──
export async function fetchMyPresence() {
  return rcFetch('/account/~/extension/~/presence');
}

export async function fetchAllPresence() {
  // Returns presence for all extensions (requires ReadPresence scope)
  return rcFetch('/account/~/presence?detailedTelephonyState=true&sipData=true');
}

export async function fetchCallLog(params = {}) {
  const qs = new URLSearchParams({ perPage: 50, ...params });
  return rcFetch('/account/~/extension/~/call-log?' + qs);
}

export async function fetchExtensions() {
  return rcFetch('/account/~/extension?perPage=200&type=User&status=Enabled');
}

// ── Set MVP presence/DND for any extension (requires admin or EditPresence scope) ──
// dndStatus: 'TakeAllCalls' | 'DoNotAcceptAnyCalls' | 'DoNotAcceptDepartmentCalls'
export async function setAgentPresence(extensionId, dndStatus) {
  return rcFetch(`/account/~/extension/${extensionId}/presence`, {
    method: 'PUT',
    body: JSON.stringify({ dndStatus }),
  });
}
