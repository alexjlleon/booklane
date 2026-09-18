'use strict';
// Minimal zero-dependency HTTP router with middleware, JSON bodies, cookies and static files.
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.ics': 'text/calendar; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true' || (!!process.env.RAILWAY_ENVIRONMENT && process.env.TRUST_PROXY !== 'false');

class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function compile(pattern) {
  const keys = [];
  const src = pattern.replace(/\/:([A-Za-z_]+)(\?)?/g, (_, k, opt) => { keys.push(k); return opt ? '(?:/([^/]+))?' : '/([^/]+)'; })
    .replace(/\*$/, '(.*)');
  return { re: new RegExp('^' + src + '/?$'), keys };
}

function createRouter() {
  const routes = [];
  const middleware = [];
  const add = (method) => (pattern, ...handlers) => routes.push({ method, pattern, ...compile(pattern), handlers });
  const app = {
    use: (fn) => middleware.push(fn),
    get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'),
    routes,
    handler: null,
  };

  function enhance(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); req.path = decodeURI(url.pathname); } catch { req.path = '/'; req.query = {}; req.cookies = {}; throw new HttpError(400, 'Bad request'); }
    req.query = Object.fromEntries(url.searchParams);
    req.cookies = parseCookies(req.headers.cookie);
    const xff = (req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    // Only trust X-Forwarded-For behind a known proxy (Railway sets RAILWAY_ENVIRONMENT). Use the entry the proxy appended.
    req.ip = (TRUST_PROXY && xff.length ? xff[xff.length - 1] : null) || req.socket.remoteAddress;
    res.status = (code) => { res.statusCode = code; return res; };
    res.set = (k, v) => { res.setHeader(k, v); return res; };
    res.json = (obj) => { if (res.writableEnded) return; res.setHeader('Content-Type', MIME['.json']); res.end(JSON.stringify(obj)); };
    res.html = (str) => { res.setHeader('Content-Type', MIME['.html']); res.end(str); };
    res.text = (str, type = MIME['.txt']) => { res.setHeader('Content-Type', type); res.end(str); };
    res.redirect = (loc, code = 302) => { res.statusCode = code; res.setHeader('Location', loc); res.end(); };
    res.cookie = (name, value, opts = {}) => {
      let c = `${name}=${encodeURIComponent(value)}; Path=${opts.path || '/'}; SameSite=${opts.sameSite || 'Lax'}`;
      if (opts.httpOnly !== false) c += '; HttpOnly';
      if (opts.secure) c += '; Secure';
      if (opts.maxAge != null) c += `; Max-Age=${Math.floor(opts.maxAge)}`;
      const prev = res.getHeader('Set-Cookie');
      res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
      return res;
    };
  }

  async function readBody(req, limit = 1_000_000) {
    if (req.method === 'GET' || req.method === 'HEAD') return {};
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'Payload too large');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    req.rawBody = raw;
    if (!raw) return {};
    const type = req.headers['content-type'] || '';
    if (type.includes('application/json') || type.includes('text/plain')) {
      try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
    }
    if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
    return {};
  }

  app.handler = async (req, res) => {
    try {
      enhance(req, res);
      req.body = await readBody(req);
      const stack = [...middleware];
      let matched = null;
      for (const r of routes) {
        if (r.method !== req.method && !(req.method === 'HEAD' && r.method === 'GET')) continue;
        const m = r.re.exec(req.path);
        if (!m) continue;
        req.params = {};
        r.keys.forEach((k, i) => { if (m[i + 1] !== undefined) req.params[k] = decodeURIComponent(m[i + 1]); });
        matched = r; break;
      }
      for (const fn of stack) {
        if (res.writableEnded) return;
        await fn(req, res);
      }
      if (res.writableEnded) return;
      if (!matched) throw new HttpError(404, 'Not found');
      for (const h of matched.handlers) {
        if (res.writableEnded) return;
        const out = await h(req, res);
        if (out !== undefined && !res.writableEnded) res.json(out);
      }
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[error]', req.method, req.path, err);
      if (res.writableEnded) return;
      res.statusCode = status;
      if (!req.path) req.path = '/';
      if (req.path.startsWith('/api/') || (req.headers.accept || '').includes('application/json')) {
        res.json({ error: status >= 500 ? 'Something went wrong' : err.message, details: err.details });
      } else {
        res.setHeader('Content-Type', MIME['.html']);
        res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status}</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;color:#222"><div style="text-align:center"><h1 style="font-size:56px;margin:0">${status}</h1><p>${status === 404 ? 'We could not find that page.' : 'Something went wrong.'}</p></div>`);
      }
    }
  };
  return app;
}

function serveStatic(root, prefix = '/static') {
  const absRoot = path.resolve(root);
  return async (req, res) => {
    if (!req.path.startsWith(prefix + '/') || (req.method !== 'GET' && req.method !== 'HEAD')) return;
    const rel = req.path.slice(prefix.length);
    const file = path.resolve(path.join(absRoot, rel));
    if (!file.startsWith(absRoot)) return;
    let stat;
    try { stat = fs.statSync(file); } catch { return; }
    if (!stat.isFile()) return;
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', process.env.NODE_ENV === 'production' ? 'public, max-age=3600' : 'no-cache');
    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') return res.end();
    await new Promise((resolve) => fs.createReadStream(file).on('end', resolve).on('error', resolve).pipe(res));
  };
}

module.exports = { createRouter, serveStatic, HttpError, MIME };
