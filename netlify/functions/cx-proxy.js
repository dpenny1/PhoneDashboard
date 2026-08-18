// Netlify Function — CXone API proxy
// Replaces the Cloudflare Worker. Handles all /cx/* /sync/* /enforce/* routes.
// Environment variables (set in Netlify dashboard → Site settings → Environment variables):
//   CX_BASE_URL      = https://na1.nice-incontact.com
//   ALLOWED_ORIGIN   = https://dpenny1.github.io
//   CX_SYSTEM_TOKEN  = <admin CXone token for enforcement>

const CX_BASE   = process.env.CX_BASE_URL    || 'https://na1.nice-incontact.com';
const ORIGIN    = process.env.ALLOWED_ORIGIN  || 'https://dpenny1.github.io';
const SYS_TOKEN = process.env.CX_SYSTEM_TOKEN || '';

// In-memory enforcement state (resets on cold start — for persistence use Netlify Blobs or a DB)
const enforceState = {};
let enforceConfig = {
  enabled:       false,
  startTime:     '08:00',
  endTime:       '17:00',
  warnMinutes:   5,
  logoutMinutes: 10,
  allowWeekends: false,
};

// ─── CORS headers ────────────────────────────────────────────────────────────
function cors(origin) {
  const allowed = origin === ORIGIN || origin === 'http://localhost' || (origin||'').startsWith('http://localhost:') || (origin||'').startsWith('http://127.0.0.1');
  return {
    'Access-Control-Allow-Origin':  allowed ? origin : ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(body, status = 200, origin = ORIGIN) {
  return { statusCode: status, headers: { ...cors(origin), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function err(msg, status = 400, origin = ORIGIN) {
  return json({ error: msg }, status, origin);
}

// ─── CXone helpers ───────────────────────────────────────────────────────────
async function cxPost(path, body, token) {
  const resp = await fetch(`${CX_BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body:    JSON.stringify(body),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

async function cxGet(path, token) {
  const resp = await fetch(`${CX_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

// ─── Route handlers ───────────────────────────────────────────────────────────

// POST /cx/token — CXone ROPC login
async function handleCxToken(body, origin) {
  const { username, password } = body;
  if (!username || !password) return err('username and password required', 400, origin);

  const params = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
    scope: 'AgentApi',
  });

  const resp = await fetch(`${CX_BASE}/authentication/v1/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });

  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    return err(e.error_description || 'CXone login failed', resp.status, origin);
  }

  const data = await resp.json();

  // Fetch agent info while we have the token
  let agentInfo = null;
  try {
    const aiResp = await fetch(`${CX_BASE}/inContactAPI/services/v28.0/agents/state`, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (aiResp.ok) {
      const ai = await aiResp.json();
      agentInfo = ai.agentStateList?.[0] || null;
    }
  } catch {}

  return json({ ...data, agentInfo }, 200, origin);
}

// POST /cx/refresh — refresh CXone token
async function handleCxRefresh(body, origin) {
  const { refresh_token } = body;
  if (!refresh_token) return err('refresh_token required', 400, origin);

  const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token });
  const resp = await fetch(`${CX_BASE}/authentication/v1/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });

  if (!resp.ok) return err('Token refresh failed', resp.status, origin);
  return json(await resp.json(), 200, origin);
}

// GET /cx/agents — all agent states
async function handleCxAgents(authHeader, origin) {
  const token = (authHeader || '').replace('Bearer ', '');
  if (!token) return err('No token', 401, origin);

  const { ok, status, data } = await cxGet('/inContactAPI/services/v28.0/agents/states?updatedSince=0', token);
  if (!ok) return err('CXone agents fetch failed', status, origin);
  return json(data, 200, origin);
}

// GET /cx/queues — queue/skill stats
async function handleCxQueues(authHeader, origin) {
  const token = (authHeader || '').replace('Bearer ', '');
  if (!token) return err('No token', 401, origin);

  const { ok, status, data } = await cxGet('/inContactAPI/services/v28.0/skills/summary?fields=skillId,skillName,contactsQueued,agentsAvailable,longestQueueDuration', token);
  if (!ok) return err('CXone queues fetch failed', status, origin);
  return json(data, 200, origin);
}

// POST /sync/status — push CXone state → RC MVP DND status
async function handleSyncStatus(body, origin) {
  const { cxState, rcToken, rcExtensionId } = body;
  if (!cxState || !rcToken || !rcExtensionId) return err('cxState, rcToken, rcExtensionId required', 400, origin);

  const DND_MAP = {
    'Available':  'TakeAllCalls',
    'On Call':    'TakeAllCalls',
    'ACW':        'TakeAllCalls',
    'Break':      'DoNotAcceptAnyCalls',
    'Lunch':      'DoNotAcceptAnyCalls',
    'Training':   'DoNotAcceptDepartmentCalls',
    'Refused':    'DoNotAcceptAnyCalls',
    'Logged Out': 'DoNotAcceptAnyCalls',
  };

  const dndStatus = DND_MAP[cxState] || 'TakeAllCalls';
  const resp = await fetch(`https://platform.ringcentral.com/restapi/v1.0/account/~/extension/${rcExtensionId}/presence`, {
    method:  'PUT',
    headers: { Authorization: `Bearer ${rcToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ dndStatus }),
  });

  if (!resp.ok) return err('RC presence update failed', resp.status, origin);
  return json({ success: true, dndStatus }, 200, origin);
}

// GET /enforce/status
function handleEnforceStatus(origin) {
  return json(enforceState, 200, origin);
}

// GET /enforce/config
function handleEnforceConfigGet(origin) {
  return json(enforceConfig, 200, origin);
}

// POST /enforce/config
function handleEnforceConfigPost(body, origin) {
  enforceConfig = { ...enforceConfig, ...body };
  return json({ success: true, config: enforceConfig }, 200, origin);
}

// GET /health
function handleHealth(origin) {
  return json({ status: 'ok', ts: new Date().toISOString() }, 200, origin);
}

// ─── Enforcement cron (called by Netlify scheduled function) ─────────────────
async function runEnforcement() {
  if (!enforceConfig.enabled || !SYS_TOKEN) return;

  const now = new Date();
  const day = now.getDay();
  if (!enforceConfig.allowWeekends && (day === 0 || day === 6)) return;

  const toMins = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
  const nowMins = now.getHours()*60 + now.getMinutes();
  const start   = toMins(enforceConfig.startTime);
  const end     = toMins(enforceConfig.endTime);
  const inWindow = nowMins >= start && nowMins <= end;

  const { data } = await cxGet('/inContactAPI/services/v28.0/agents/states?updatedSince=0', SYS_TOKEN);
  const stateList = data?.agentStateList || [];
  const available = stateList.filter(a => (a.currentState||'').toLowerCase() === 'available');

  for (const agent of available) {
    const id = agent.agentId;
    const key = `agent_${id}`;
    const durMin = Math.floor((agent.currentStateDuration || 0) / 60);

    if (!inWindow) {
      // After hours — warn if not already warned
      if (!enforceState[key]) {
        enforceState[key] = { agentId: id, agentName: agent.agentName, warnedAt: Date.now(), phase: 'warned' };
        await cxPost(`/inContactAPI/services/v28.0/agents/${id}/message`, { message: 'You are available outside working hours. Please log out of CXone.' }, SYS_TOKEN);
      } else if (enforceState[key].phase === 'warned') {
        const minsSinceWarn = (Date.now() - enforceState[key].warnedAt) / 60000;
        if (minsSinceWarn >= enforceConfig.logoutMinutes) {
          enforceState[key].phase = 'loggedout';
          await cxPost(`/inContactAPI/services/v28.0/agents/${id}/logout`, {}, SYS_TOKEN);
        }
      }
    } else {
      // In window — clear any enforcement state
      delete enforceState[key];
    }
  }

  // Clean up agents no longer available
  for (const key of Object.keys(enforceState)) {
    const id = enforceState[key].agentId;
    if (!available.find(a => a.agentId === id)) delete enforceState[key];
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const origin = event.headers?.origin || ORIGIN;

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(origin), body: '' };
  }

  // Strip Netlify function prefix to get the logical path
  // Netlify calls this function at /.netlify/functions/cx-proxy
  // but we redirect /cx/* → this function, so event.path will be the original path
  const path   = event.path.replace(/^\/.netlify\/functions\/cx-proxy/, '') || '/';
  const method = event.httpMethod;
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch {}

  const auth = event.headers?.authorization || '';

  // Scheduled enforcement call (triggered via Netlify scheduled function)
  if (path === '/enforce/run' && method === 'POST') {
    await runEnforcement();
    return json({ ran: true }, 200, origin);
  }

  if (path === '/cx/token'          && method === 'POST') return handleCxToken(body, origin);
  if (path === '/cx/refresh'        && method === 'POST') return handleCxRefresh(body, origin);
  if (path === '/cx/agents'         && method === 'GET')  return handleCxAgents(auth, origin);
  if (path === '/cx/queues'         && method === 'GET')  return handleCxQueues(auth, origin);
  if (path === '/sync/status'       && method === 'POST') return handleSyncStatus(body, origin);
  if (path === '/enforce/status'    && method === 'GET')  return handleEnforceStatus(origin);
  if (path === '/enforce/config'    && method === 'GET')  return handleEnforceConfigGet(origin);
  if (path === '/enforce/config'    && method === 'POST') return handleEnforceConfigPost(body, origin);
  if (path === '/health'            && method === 'GET')  return handleHealth(origin);

  return err('Not found', 404, origin);
};
