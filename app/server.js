// Tiny Shop server: zero-dependency static server + a tiny orders API.
// Serves files from app/public on every request (no caching), so the
// self-healing loop can patch a file and the next Kane run sees it
// immediately, with no server restart.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);

// Server-side price list (cents). The server re-computes every order total
// from this list, so a client-side total can never be trusted blindly.
const PRICES = {
  headphones: 8999,
  cable: 1250,
  keyboard: 7400,
  lamp: 3495,
  notebook: 999,
  bottle: 1995,
};

const orders = new Map(); // orderId -> order
let orderCounter = 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': MIME['.json'] });
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/api/orders') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const { name, email, address, items } = body || {};
    if (!name || !email || !address || !Array.isArray(items) || items.length === 0) {
      sendJson(res, 400, { error: 'Missing name, email, address or items' });
      return;
    }
    let total = 0;
    const lines = [];
    for (const item of items) {
      const price = PRICES[item.id];
      const qty = Number(item.qty);
      if (price === undefined || !Number.isInteger(qty) || qty < 1 || qty > 99) {
        sendJson(res, 400, { error: `Invalid item: ${item.id}` });
        return;
      }
      total += price * qty;
      lines.push({ id: item.id, qty, price });
    }
    const orderId = `TS-${++orderCounter}`;
    const order = { orderId, name, email, address, items: lines, total, createdAt: new Date().toISOString() };
    orders.set(orderId, order);
    sendJson(res, 201, { orderId, total });
    return;
  }

  const orderMatch = url.pathname.match(/^\/api\/orders\/([A-Za-z0-9-]+)$/);
  if (req.method === 'GET' && orderMatch) {
    const order = orders.get(orderMatch[1]);
    if (!order) {
      sendJson(res, 404, { error: 'Order not found' });
      return;
    }
    sendJson(res, 200, order);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, orders: orders.size });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`Tiny Shop running at http://localhost:${PORT}`);
});
