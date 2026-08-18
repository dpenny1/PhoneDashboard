// ── RingCentral + CXone Middleware Worker ─────────────────────────────────────
// Deploy to Cloudflare Workers at: https://dash.cloudflare.com
//
// Environment variables to set in Cloudflare dashboard:
//   RC_CLIENT_ID     = dwLXTnila2ydldmUAljjhn
//   CX_BASE_URL      = https://na1.nice-incontact.com
//   ALLOWED_ORIGIN   = https://dpenny1.github.io
//   CX_SYSTEM_TOKEN  = (CXone token for the system/admin account used for enforcement)
//
// KV Namespace to bind in Cloudflare dashboard:
//   Binding name: ENFORCE_KV   (stores warning state per agent)
//
// Cron trigger to add in Cloudflare dashboard (wrangler.toml or UI):
//   */5 * * * *   (runs every 5 minutes)
//
// wrangler.toml example:
//   [triggers]
//   crons = ["*/5 * * * *"]
//   [[kv_namespaces]]
//   binding = "ENFORCE_KV"
//   id = "YOUR_KV_NAMESPACE_ID"

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

    // GET /enforce/status — get current enforcement warnings (for supervisor dashboard)
    if (url.pathname === '/enforce/status' && request.method === 'GET') {
      return handleEnforceStatus(request, env, allowed);
    }

    // POST /enforce/config — save time window config
    if (url.pathname === '/enforce/config' && request.method === 'POST') {
      return handleEnforceConfig(request, env, allowed);
    }

    // GET /enforce/config — get time window config
    if (url.pathname === '/enforce/config' && request.method === 'GET') {
      return handleGetEnforceConfig(request, env, allowed);
    }

    // Health check
    if (url.pathname === '/health') {
      return json({ status: 'ok', ts: new Date().toISOString() }, 200, allowed);
    }

    return error('Not found', 404, allowed);
  },

  // ── Cron: runs every 5 minutes ──────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runEnforcement(env));
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

// ══════════════════════════════════════════════════════════════════════════════
// ── TIME-WINDOW ENFORCEMENT ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//
// Phase 1 — Warn:    Send CXone notification to agent (warn_minutes before cutoff)
// Phase 2 — Alert:   Store alert in KV so supervisor dashboard can surface it
// Phase 3 — Logout:  Force-logout via CXone API (logout_minutes after warning)
//
// Default config (overridden via /enforce/config):
const DEFAULT_CONFIG = {
  enabled:        true,
  startHour:      7,    // 7:00 AM
  endHour:        19,   // 7:00 PM
  timezone:       'America/Chicago',
  warnMinutes:    15,   // warn this many minutes before cutoff
  logoutMinutes:  15,   // force logout this many minutes after warning
  weekendsOff:    true, // no contact center on Sat/Sun
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function getNowInTZ(tz) {
  return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
}

function isWithinWindow(config) {
  const now = getNowInTZ(config.timezone);
  const day = now.getDay(); // 0=Sun, 6=Sat
  if (config.weekendsOff && (day === 0 || day === 6)) return false;
  const h = now.getHours() + now.getMinutes() / 60;
  return h >= config.startHour && h < config.endHour;
}

function minutesUntilCutoff(config) {
  const now = getNowInTZ(config.timezone);
  const cutoffToday = new Date(now);
  cutoffToday.setHours(config.endHour, 0, 0, 0);
  return (cutoffToday - now) / 60000;
}

// ── CXone: Send notification to agent ────────────────────────────────────────
async function cxNotifyAgent(agentId, message, systemToken, cxBase) {
  const resp = await fetch(`${cxBase}/inContactAPI/services/v28.0/agents/${agentId}/message`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + systemToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  return resp.ok;
}

// ── CXone: Force logout agent ─────────────────────────────────────────────────
async function cxForceLogout(agentId, systemToken, cxBase) {
  const resp = await fetch(`${cxBase}/inContactAPI/services/v28.0/agents/${agentId}/logout`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + systemToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ forceLogout: true }),
  });
  return resp.ok;
}

// ── Main enforcement cron function ────────────────────────────────────────────
async function runEnforcement(env) {
  const kv          = env.ENFORCE_KV;
  const systemToken = env.CX_SYSTEM_TOKEN;
  const cxBase      = env.CX_BASE_URL || 'https://na1.nice-incontact.com';

  if (!kv || !systemToken) {
    console.log('Enforcement: ENFORCE_KV or CX_SYSTEM_TOKEN not configured, skipping.');
    return;
  }

  // Load config
  const configStr = await kv.get('enforce_config');
  const config = configStr ? JSON.parse(configStr) : DEFAULT_CONFIG;
  if (!config.enabled) return;

  const inWindow  = isWithinWindow(config);
  const minsLeft  = minutesUntilCutoff(config);
  const now       = Date.now();

  // Fetch all logged-in agents
  const agentsResp = await fetch(
    `${cxBase}/inContactAPI/services/v28.0/agents/states?fields=agentId,agentName,currentState,isActive`,
    { headers: { Authorization: 'Bearer ' + systemToken } }
  );
  if (!agentsResp.ok) { console.error('Enforcement: failed to fetch agents'); return; }

  const data = await agentsResp.json();
  const loggedInAgents = (data.agentStateList || []).filter(a =>
    a.isActive && a.currentState !== 'Logged Out'
  );

  console.log(`Enforcement: ${loggedInAgents.length} agents logged in. inWindow=${inWindow} minsLeft=${minsLeft.toFixed(1)}`);

  for (const agent of loggedInAgents) {
    const agentId  = agent.agentId;
    const kvKey    = `enforce_${agentId}`;
    const stateStr = await kv.get(kvKey);
    const state    = stateStr ? JSON.parse(stateStr) : null;

    if (inWindow) {
      // Inside window — approaching cutoff?
      if (minsLeft <= config.warnMinutes && minsLeft > 0) {
        // Phase 1: Warn (only once per session)
        if (!state?.warnedAt) {
          const msg = `⚠ Your contact center session will end in ${Math.round(minsLeft)} minute(s). Please wrap up your current call.`;
          await cxNotifyAgent(agentId, msg, systemToken, cxBase);
          // Phase 2: Alert supervisor via KV
          await kv.put(kvKey, JSON.stringify({
            agentId, agentName: agent.agentName,
            warnedAt: now,
            phase: 'warned',
          }), { expirationTtl: 3600 });
          console.log(`Enforcement: warned agent ${agent.agentName}`);
        }
      } else if (minsLeft > config.warnMinutes && state) {
        // Back inside safe window — clear any pending state
        await kv.delete(kvKey);
      }
    } else {
      // Outside window (or weekend)
      if (!state?.warnedAt) {
        // Missed the pre-window warning (agent logged in after hours) — warn immediately
        const msg = `⚠ The contact center is now closed. You will be logged out automatically in ${config.logoutMinutes} minute(s).`;
        await cxNotifyAgent(agentId, msg, systemToken, cxBase);
        await kv.put(kvKey, JSON.stringify({
          agentId, agentName: agent.agentName,
          warnedAt: now,
          phase: 'warned',
        }), { expirationTtl: 3600 });
        console.log(`Enforcement: warned after-hours agent ${agent.agentName}`);

      } else if (state.phase === 'warned') {
        const minsSinceWarn = (now - state.warnedAt) / 60000;
        if (minsSinceWarn >= config.logoutMinutes) {
          // Phase 3: Force logout
          const success = await cxForceLogout(agentId, systemToken, cxBase);
          await kv.put(kvKey, JSON.stringify({
            ...state, phase: 'loggedout', loggedOutAt: now,
          }), { expirationTtl: 3600 });
          console.log(`Enforcement: force-logged out ${agent.agentName} (success=${success})`);
        }
        // else still in warning window — leave in place, supervisor can see it
      }
    }
  }

  // Clean up KV entries for agents who are now logged out
  const activeIds = new Set(loggedInAgents.map(a => String(a.agentId)));
  const { keys } = await kv.list({ prefix: 'enforce_' });
  for (const key of keys) {
    const id = key.name.replace('enforce_', '');
    if (!activeIds.has(id)) await kv.delete(key.name);
  }
}

// ── HTTP: Get current enforcement alerts for supervisor dashboard ─────────────
async function handleEnforceStatus(request, env, origin) {
  const kv = env.ENFORCE_KV;
  if (!kv) return json({ alerts: [] }, 200, origin);

  const { keys } = await kv.list({ prefix: 'enforce_' });
  const alerts = [];
  for (const key of keys) {
    const val = await kv.get(key.name);
    if (val) alerts.push(JSON.parse(val));
  }
  return json({ alerts }, 200, origin);
}

// ── HTTP: Save time window config ─────────────────────────────────────────────
async function handleEnforceConfig(request, env, origin) {
  const kv = env.ENFORCE_KV;
  if (!kv) return error('ENFORCE_KV not configured', 500, origin);
  let body;
  try { body = await request.json(); } catch { return error('Invalid JSON', 400, origin); }
  await kv.put('enforce_config', JSON.stringify({ ...DEFAULT_CONFIG, ...body }));
  return json({ success: true }, 200, origin);
}

// ── HTTP: Get time window config ──────────────────────────────────────────────
async function handleGetEnforceConfig(request, env, origin) {
  const kv = env.ENFORCE_KV;
  if (!kv) return json(DEFAULT_CONFIG, 200, origin);
  const val = await kv.get('enforce_config');
  return json(val ? JSON.parse(val) : DEFAULT_CONFIG, 200, origin);
}
