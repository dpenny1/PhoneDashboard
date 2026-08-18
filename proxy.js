// CXone local proxy — run with: node proxy.js
// Forwards browser requests to CXone to get around CORS restrictions.
// Keep this running on your computer while using the dashboard.

const http  = require('http');
const https = require('https');

const PORT    = 3000;
const CX_HOST = 'na1.nice-incontact.com';

http.createServer((req, res) => {

  // Allow the browser (any origin) to call this proxy
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Strip headers that would confuse CXone
  const headers = { ...req.headers, host: CX_HOST };
  delete headers['origin'];
  delete headers['referer'];

  const proxyReq = https.request(
    { hostname: CX_HOST, port: 443, path: req.url, method: req.method, headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', e => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); });
  req.pipe(proxyReq);

}).listen(PORT, () => {
  console.log('');
  console.log('  CXone proxy running at http://localhost:' + PORT);
  console.log('  Keep this window open while using the dashboard.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
