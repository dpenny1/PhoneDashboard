// CXone local proxy — run with: node proxy.js
// Forwards browser requests to CXone, following redirects automatically.

const http  = require('http');
const https = require('https');

const PORT    = 3000;
const CX_HOST = 'na1.nice-incontact.com';

// Buffer the full request body, then proxy with redirect following
http.createServer((req, res) => {

  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Buffer body first so we can replay it on redirects
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    forward(`https://${CX_HOST}${req.url}`, req.method, req.headers, body, res, 0);
  });

}).listen(PORT, () => {
  console.log('');
  console.log('  CXone proxy running at http://localhost:' + PORT);
  console.log('  Keep this window open while using the dashboard.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

function forward(url, method, origHeaders, body, res, depth) {
  if (depth > 10) { res.writeHead(508); res.end('Too many redirects'); return; }

  const u = new URL(url);
  const headers = { ...origHeaders, host: u.hostname };
  delete headers['origin'];
  delete headers['referer'];
  if (body.length) headers['content-length'] = body.length;

  const opts = { hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers };

  const proxyReq = https.request(opts, proxyRes => {
    const { statusCode, headers: rh } = proxyRes;

    // Follow redirects
    if ([301, 302, 303, 307, 308].includes(statusCode) && rh.location) {
      const next = rh.location.startsWith('http')
        ? rh.location
        : `https://${u.hostname}${rh.location}`;
      console.log(`  Redirect ${statusCode} → ${next}`);
      // 303 always becomes GET with no body
      const nextMethod = statusCode === 303 ? 'GET' : method;
      const nextBody   = statusCode === 303 ? Buffer.alloc(0) : body;
      forward(next, nextMethod, origHeaders, nextBody, res, depth + 1);
      return;
    }

    // Pass CORS headers through but override Allow-Origin so browser accepts it
    const safe = { ...rh };
    safe['access-control-allow-origin']  = '*';
    safe['access-control-allow-headers'] = 'Content-Type, Authorization';

    res.writeHead(statusCode, safe);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', e => {
    console.error('  Proxy error:', e.message);
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });

  if (body.length) proxyReq.write(body);
  proxyReq.end();
}
