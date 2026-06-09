// Tiny static server for the tailnet root directory page.
// No dependencies; index.html is read per request so edits are live.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.TANGO_HOME_PORT ?? 9310);
const HOST = process.env.TANGO_HOME_HOST ?? '127.0.0.1';
const indexPath = join(dirname(fileURLToPath(import.meta.url)), 'index.html');

createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname !== '/' && pathname !== '/index.html') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  try {
    const html = await readFile(indexPath);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(html);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('index.html missing');
  }
}).listen(PORT, HOST, () => {
  console.log(`[home] serving ${indexPath} on http://${HOST}:${PORT}`);
});
