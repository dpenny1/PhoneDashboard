// ── RingCentral + CXone Middleware Worker ─────────────────────────────────────
// Deploy to Cloudflare Workers at: https://dash.cloudflare.com
//
// Environment variables to set in Cloudflare dashboard:
//   RC_CLIENT_ID     = dwLXTnila2ydldmUAljjhn
//   CX_BASE_URL      = https://na1.nice-incontact.com
//   ALLOWED_ORIGIN   = https://dpenny1.github.io

const CORS_HEADERS = (origin) => ({
  'Access-Control-Allow-Origin':  origin || '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age':       '86400',
});

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS(origin) },
  });
}

function error(message, status = 400, origin) {
  return json({ error: message }, status, origin);
}

// ── Router ────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGIN || 'https://dpenny1.github.io';

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS(allowed) });
    }

    // Block non-allowed origins in production
    if (origin && !origin.startsWith(allowed) && !origin.includes('localhost')) {
      return error('Forbidden', 403, origin);
    }

    const url = new URL(request.url);

    // POST /cx/token  — CXone username/password login (ROPC)
    if (url.pathname === '/cx/token' && request.method === 'POST') {
      return handleCxToken(request, env, allowed);
    }

    // POST /cx/refresh — CXone token refresh
    if (url.pathname === '/cx/refresh' && request.method === 'POST') {
      return handleCxRefresh(request, env, allowed);
    }

    // GET /cx/agents  — fetch all agent states
    if (url.pathname === '/cx/agents' && request.method === 'GET') {
      return handleCxAgents(request, env, allowed);
    }

    // GET /cx/queues  — fetch queue stats
    if (url.pathname === '/cx/queues' && request.method === 'GET') {
      return handleCxQueues(request, env, allowed);
    }

    // POST /sync/status — sync CXone state → RC MVP presence
    if (url.pathname === '/sync/status' && request.method === 'POST') {
      return handleStatusSync(request, env, allowed);
    }

    // Health check
    if (url.pathname === '/health') {
      return json({ status: 'ok', ts: new Date().toISOString() }, 200, allowed);
    }

    return error('Not found', 404, allowed);
  },
};

// ── CXone: Username/Password Token (ROPC) ─────────────────────────────────────
async function handleCxToken(request, env, origin) {
  let body;
  try { body = await request.json(); }
  catch { return error('Invalid JSON body', 400, origin); }

  const { username, password } = body;
  if (!username || !password) return error('username and password required', 400, origin);

  const cxBase = env.CX_BASE_URL || 'https://na1.nice-incontact.com';

  // CXone ROPC token endpoint
  const tokenResp = await fetch(`${cxBase}/authentication/v1/token/access-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      username,
      password,
      scope: 'openid profile',
    }),
  });

  if (!tokenResp.ok) {
    const text = await tokenResp.text();
    console.error('CXone token error:', tokenResp.status, text);
    // Try to return a helpful error
    if (tokenResp.status === 401) return error('Invalid CXone username or password', 401, origin);
    return error('CXone authentication failed: ' + tokenResp.status, tokenResp.status, origin);
  }

  const tokens = await tokenResp.json();

  // Also fetch the user's own agent info
  let agentInfo = null;
  try {
    const meResp = await fetch(`${cxBase}/inContactAPI/services/v28.0/agents/~`, {
      headers: { Authorization: 'Bearer ' + tokens.access_token },
    });
    if (meResp.ok) agentInfo = (await meResp.json())?.agentList?.[0] || null;
  } catch (e) { /* non-fatal */ }

  return json({ ...tokens, agentInfo }, 200, origin);
}

// ── CXone: Refresh Token ──────────────────────────────────────────────────────
async function handleCxRefresh(request, env, origin) {
  let body;
  try { body = await request.json(); }
  catch { return error('Invalid JSON body', 400, origin); }

  const { refresh_token } = body;
  if (!refresh_token) return error('refresh_token required', 400, origin);

  const cxBase = env.CX_BASE_URL || 'https://na1.nice-incontact.com';
  const tokenResp = await fetch(`${cxBase}/authentication/v1/token/access-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token }),
  });

  if (!tokenResp.ok) return error('Token refresh failed', 401, origin);
  return json(await tokenResp.json(), 200, origin);
}

// ── CXone: All Agent States ───────────────────────────────────────────────────
async function handleCxAgents(request, env, origin) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return error('Authorization header required', 401, origin);

  const cxBase = env.CX_BASE_URL || 'https://na1.nice-incontact.com';
  const resp = await fetch(
    `${cxBase}/inContactAPI/services/v28.0/agents/states?fields=agentId,agentName,currentState,currentStateDuration,teamId,teamName,isActive`,
    { headers: { Authorization: authHeader } }
  );

  if (!resp.ok) return error('Failed to fetch agent states: ' + resp.status, resp.status, origin);
  return json(await resp.json(), 200, origin);
}

// ── CXone: Queue Stats ────────────────────────────────────────────────────────
async function handleCxQueues(request, env, origin) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return error('Authorization header required', 401, origin);

  const cxBase = env.CX_BASE_URL || 'https://na1.nice-incontact.com';
  const resp = await fetch(
    `${cxBase}/inContactAPI/services/v28.0/realtime-data/skill-activity`,
    { headers: { Authorization: authHeader } }
  );

  if (!resp.ok) return error('Failed to fetch queue stats: ' + resp.status, resp.status, origin);
  return json(await resp.json(), 200, origin);
}

// ── Status Sync: CXone state → RC MVP presence ───────────────────────────────
// Map CXone states to RC MVP presence
const STATE_MAP = {
  'Available':  { dndStatus: 'TakeAllCalls',           userStatus: 'Available' },
  'On Call':    { dndStatus: 'TakeAllCalls',           userStatus: 'Busy' },
  'ACW':        { dndStatus: 'TakeAllCalls',           userStatus: 'Busy' },
  'Break':      { dndStatus: 'DoNotAcceptAnyCalls',    userStatus: 'Available' },
  'Lunch':      { dndStatus: 'DoNotAcceptAnyCalls',    userStatus: 'Available' },
  'Training':   { dndStatus: 'DoNotAcceptDepartmentCalls', userStatus: 'Available' },
  'Logged Out': { dndStatus: 'DoNotAcceptAnyCalls',    userStatus: 'Offline' },
  'Refused':    { dndStatus: 'DoNotAcceptAnyCalls',    userStatus: 'Available' },
};

const RC_API = 'https://platform.ringcentral.com/restapi/v1.0';

async function handleStatusSync(request, env, origin) {
  let body;
  try { body = await request.json(); }
  catch { return error('Invalid JSON body', 400, origin); }

  const { cxState, rcToken, rcExtensionId } = body;
  if (!cxState || !rcToken) return error('cxState and rcToken required', 400, origin);

  const presence = STATE_MAP[cxState];
  if (!presence) return error('Unknown CXone state: ' + cxState, 400, origin);

  const extId = rcExtensionId || '~';
  const resp = await fetch(`${RC_API}/account/~/extension/${extId}/presence`, {
    method: 'PUT',
    headers: {
      Authorization:  'Bearer ' + rcToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ dndStatus: presence.dndStatus }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error('RC presence update failed:', resp.status, text);
    return error('RC presence update failed: ' + resp.status, resp.status, origin);
  }

  return json({ success: true, cxState, applied: presence }, 200, origin);
}
