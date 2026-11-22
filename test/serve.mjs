import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const csp = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self'",
  "connect-src 'self'", "worker-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'"
].join('; ');
const files = new Map([
  ['', 'index.html'], ['index.html', 'index.html'], ['style.css', 'style.css'], ['mark.svg', 'mark.svg'], ['sw.js', 'sw.js'],
  ...['app', 'map', 'brief', 'model', 'audit', 'cities', 'interventions', 'policy',
    'policyview', 'selftest', 'sha256'].map(name => [`src/${name}.js`, `src/${name}.js`])
]);
const mime = { html: 'text/html', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' };

export async function serve(port = 0) {
  const server = createServer(async (request, res) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-cache');
    const path = request.url.split('?')[0];
    if (path === '/transitgap') return res.writeHead(308, { Location: '/transitgap/' }).end();
    const file = path.startsWith('/transitgap/') ? files.get(path.slice('/transitgap/'.length)) : null;
    if (!file) return res.writeHead(404).end('Not found');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    }
    try {
      const body = await readFile(new URL(`../${file}`, import.meta.url));
      res.setHeader('Content-Type', `${mime[file.split('.').at(-1)]}; charset=utf-8`);
      return res.end(request.method === 'GET' ? body : undefined);
    } catch {
      return res.writeHead(500).end('Could not read the application shell');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const server = await serve(Number(process.env.PORT ?? 4173));
  console.log(`TransitGap at http://127.0.0.1:${server.address().port}/transitgap/`);
}
