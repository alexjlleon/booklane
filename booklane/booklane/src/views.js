'use strict';
const { esc } = require('./lib/util');
const APP_NAME = process.env.APP_NAME || 'Booklane';

const safeJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '109,74,255';
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

function page({ title, description = '', business, scripts = [], styles = ['app.css'], data = {}, body = '<div id="app"></div>', bodyClass = '', embed = false }) {
  const brand = business?.brand_color && /^#[0-9a-f]{6}$/i.test(business.brand_color) ? business.brand_color : '#6d4aff';
  const v = process.env.ASSET_VERSION || '1';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta name="theme-color" content="${brand}">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='16' fill='${brand}'/><path d='M18 22h28M18 32h28M18 42h16' stroke='white' stroke-width='6' stroke-linecap='round'/></svg>`)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
${styles.map((s) => `<link rel="stylesheet" href="/static/css/${s}?v=${v}">`).join('\n')}
<style>:root{--brand:${brand};--brand-rgb:${hexToRgb(brand)}}</style>
</head>
<body class="${esc(bodyClass)}${embed ? ' is-embed' : ''}">
${body}
<script>window.__BL__=${safeJson({ appName: APP_NAME, embed, ...data })};</script>
${scripts.map((s) => `<script src="/static/js/${s}?v=${v}"></script>`).join('\n')}
</body>
</html>`;
}

module.exports = { page, APP_NAME, safeJson };
