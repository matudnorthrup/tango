import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { api } from './api.js';
import { startChangeListener } from './db.js';
import { broadcast } from './sse.js';

const PORT = Number(process.env.WORKOUT_UI_PORT ?? 9330);
// 127.0.0.1: tailnet access goes through `tailscale serve`, which proxies to
// localhost — no reason to listen on other interfaces.
const HOST = process.env.WORKOUT_UI_HOST ?? '127.0.0.1';
const TOKEN = process.env.WORKOUT_UI_TOKEN ?? '';
// Mount path used by `tailscale serve --set-path`. Tailscale strips it before
// proxying; we strip it here too so direct localhost access works the same.
const BASE_PATH = process.env.WORKOUT_UI_BASE_PATH ?? '/tango-workout';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
// dist/server/main.js -> dist/client (built), server/main.ts -> dist/client (dev via tsx)
const clientDir = path.resolve(serverDir, serverDir.includes(`${path.sep}dist${path.sep}`) ? '../client' : '../dist/client');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

const app = new Hono();

if (TOKEN) {
  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization');
    const provided = header?.replace(/^Bearer\s+/i, '') ?? c.req.query('token') ?? '';
    if (provided !== TOKEN) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });
}

app.route('/api', api);

app.get('*', async (c) => {
  const pathname = new URL(c.req.url).pathname;
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(clientDir, path.normalize(requested));
  if (!filePath.startsWith(clientDir)) return c.text('forbidden', 403);

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    return c.body(new Uint8Array(data), 200, {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
  } catch {
    // SPA fallback: serve index.html for client-side routes
    try {
      const index = await fs.readFile(path.join(clientDir, 'index.html'));
      return c.body(new Uint8Array(index), 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    } catch {
      return c.text('client build not found — run: npm run build -w @tango/workout-ui', 404);
    }
  }
});

startChangeListener((payload) => broadcast('change', payload));

const fetchWithBasePath = (request: Request): Response | Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === BASE_PATH || url.pathname.startsWith(`${BASE_PATH}/`)) {
    url.pathname = url.pathname.slice(BASE_PATH.length) || '/';
    return app.fetch(new Request(url, request));
  }
  // Tailscale strips the mount path, so proxied requests for the app root
  // arrive as '/' — serve the app. Only direct localhost hits get redirected
  // onto the base path so the router sees the URL it expects.
  if (url.pathname === '/' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
    return Response.redirect(new URL(`${BASE_PATH}/`, url).toString(), 302);
  }
  return app.fetch(request);
};

serve({ fetch: fetchWithBasePath, port: PORT, hostname: HOST }, (info) => {
  console.log(`[workout-ui] serving on http://${HOST}:${info.port}${BASE_PATH} (client: ${clientDir})`);
});
