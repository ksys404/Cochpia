import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT || 3000);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': process.env.CSP || "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; connect-src 'self' https:; font-src 'self' data: https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};

const server = http.createServer(async (req, res) => {
  const requestPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const candidate = path.resolve(root, `.${requestPath}`);
  const safe = candidate === root || candidate.startsWith(`${root}${path.sep}`);
  const file = safe ? candidate : path.join(root, 'index.html');
  try {
    const stat = await fs.stat(file);
    const target = stat.isDirectory() ? path.join(file, 'index.html') : file;
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': path.extname(target) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable', ...securityHeaders });
    res.end(await fs.readFile(target));
  } catch {
    res.writeHead(200, { 'Content-Type': types['.html'], 'Cache-Control': 'no-cache', ...securityHeaders });
    res.end(await fs.readFile(path.join(root, 'index.html')));
  }
});

server.listen(port, () => console.log(JSON.stringify({ event: 'cochpia_web_listening', port })));
