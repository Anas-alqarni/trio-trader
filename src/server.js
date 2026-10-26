import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const readBody = (req) => new Promise((resolve) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 10_000) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
});

/** Dashboard + live event stream (Server-Sent Events). */
export function startServer({ cfg, engine, log, htmlPath }) {
  const clients = new Set();
  const send = (res, ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (ev, data) => { for (const c of clients) send(c, ev, data); };

  engine.on('radar', (r) => broadcast('radar', r));
  engine.on('deal', (d) => broadcast('deal', d));
  engine.on('exit', (x) => broadcast('exit', x));
  setInterval(() => { if (clients.size) broadcast('tick', engine.snapshot(false)); }, 2000);
  setInterval(() => { if (clients.size) broadcast('full', engine.snapshot(true)); }, 20_000);
  setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 15_000);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    if (p === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(htmlPath));
    }
    if (p === '/api/state') return json(res, 200, engine.snapshot(true));
    if (p === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      send(res, 'full', engine.snapshot(true));
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/control' && req.method === 'POST') {
      const body = await readBody(req);
      if (!cfg.password) return json(res, 403, { error: 'Add DASHBOARD_PASSWORD in Railway Variables to use these buttons.' });
      if (!safeEq(body.password, cfg.password)) return json(res, 401, { error: 'Wrong password.' });
      try { return json(res, 200, await engine.control(body.action)); } catch (e) { return json(res, 500, { error: e.message }); }
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });
  server.listen(cfg.port, () => log(`dashboard listening on port ${cfg.port}`));
  return server;
}
