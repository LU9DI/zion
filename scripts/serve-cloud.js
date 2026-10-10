import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../cloud/', import.meta.url));
const port = Number(process.env.PORT || 4173);
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };
const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type':'text/plain; charset=utf-8', 'allow':'GET, HEAD' }); res.end('Method not allowed'); return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end('Bad request'); return; }
  if (pathname === '/') pathname = '/index.html';
  const safePath = normalize(pathname).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '');
  const path = join(root, safePath);
  if (!path.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
  let stat;
  try { stat = statSync(path); if (!stat.isFile()) throw new Error('not file'); }
  catch { res.writeHead(404, { 'content-type':'text/plain; charset=utf-8' }); res.end('Not found'); return; }
  res.writeHead(200, { 'content-type':mime[extname(path)] || 'application/octet-stream', 'content-length':stat.size, 'x-content-type-options':'nosniff', 'cache-control':'no-store', 'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(path).pipe(res);
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`Zion Cloud preview: http://127.0.0.1:${port}\n`));
