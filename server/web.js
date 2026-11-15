// HTTP side: pages, static assets, health/stats endpoints and the admin API.

import crypto from 'node:crypto';
import express from 'express';
import compression from 'compression';
import { readCookie } from './auth.js';

const DOC_PAGES = ['terms', 'privacy', 'guidelines'];

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function securityHeaders(config) {
  // "Sign in with Google" loads Google's script and iframe — only allowed when configured.
  const google = Boolean(config.auth.googleClientId);
  const gsi = 'https://accounts.google.com/gsi/';
  return (req, res, next) => {
    // Same-origin websocket URL, spelled out for browsers that don't map 'self' to ws(s).
    const host = String(req.get('host') || '').replace(/[^\w.:[\]-]/g, '');
    const ws = host ? ` ${req.secure ? 'wss' : 'ws'}://${host}` : '';
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        `script-src 'self'${google ? ` ${gsi}client` : ''}`,
        // Google's button script sets inline styles on its container; without them it renders broken.
        `style-src 'self'${google ? ` 'unsafe-inline' ${gsi}style` : ''}`,
        `img-src 'self' data: blob:${google ? ' https://*.googleusercontent.com' : ''}`,
        "media-src 'self' blob: mediastream:",
        "font-src 'self'",
        `connect-src 'self'${ws}${google ? ` ${gsi}` : ''}`,
        `frame-src ${google ? gsi : "'none'"}`,
        "manifest-src 'self'",
        "worker-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; '),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // "-allow-popups" keeps the Google sign-in popup working.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    res.setHeader(
      'Permissions-Policy',
      'camera=(self), microphone=(self), display-capture=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    );
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

function adminRouter({ config, moderation, users, kick }) {
  const router = express.Router();
  router.use((req, res, next) => {
    const auth = req.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !safeEqual(token, config.adminToken)) return res.status(401).json({ error: 'unauthorized' });
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(express.json({ limit: '10kb' }));

  router.get('/reports', (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
    res.json({ reports: moderation.listReports(limit) });
  });

  router.get('/bans', (req, res) => res.json({ bans: moderation.listBans() }));

  router.get('/users', (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
    res.json({ total: users.size, users: users.list(limit) });
  });

  // POST /api/admin/bans { "key": "u:<userId>" | "c:<clientId>" | "i:<ipHash>", "hours": 24, "reason": "…" }
  router.post('/bans', (req, res) => {
    const { key, hours = 24, reason = 'manual' } = req.body || {};
    if (typeof key !== 'string' || !/^[uci]:[\w-]{8,64}$/.test(key)) return res.status(400).json({ error: 'invalid key' });
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0 || h > 24 * 3650) return res.status(400).json({ error: 'invalid hours' });
    const until = moderation.ban([key], { ms: h * 3_600_000, reason: String(reason).slice(0, 200), source: 'admin' });
    kick([key], until);
    res.json({ ok: true, key, until });
  });

  router.delete('/bans/:key', (req, res) => res.json({ ok: moderation.unban(req.params.key) }));
  return router;
}

/**
 * @param {{ config: any, renderer: import('./render.js').Renderer, publicDir: string,
 *           getStats: (full?: boolean) => any, moderation: any, users: any, authRouter: express.Router,
 *           kick: Function, logger?: Console }} deps
 */
export function createWebApp({ config, renderer, publicDir, getStats, moderation, users, authRouter, kick, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(compression());
  app.use(securityHeaders(config));

  const originOf = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;
  const sendHtml = (res, html) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(html);
  };

  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...getStats(true) });
  });

  app.get('/api/stats', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(getStats());
  });

  if (config.adminToken) app.use('/api/admin', adminRouter({ config, moderation, users, kick }));
  app.use('/api', authRouter);

  // "/" is English. Visitors whose browser (or saved choice) prefers another
  // supported language are sent to /<lang>; crawlers get English.
  app.get('/', (req, res) => {
    res.vary('Accept-Language');
    res.vary('Cookie');
    const saved = readCookie(req.headers.cookie, 'lang');
    const lang = saved && renderer.has(saved) ? saved : renderer.negotiate(req.get('accept-language'));
    if (lang && lang !== 'en') return res.redirect(302, `/${lang}`);
    sendHtml(res, renderer.renderIndex({ lang: 'en', origin: originOf(req) }));
  });
  app.get(['/en', '/index.html'], (req, res) => res.redirect(301, '/'));
  for (const { code } of renderer.languages) {
    if (code === 'en') continue;
    app.get(`/${code}`, (req, res) => sendHtml(res, renderer.renderIndex({ lang: code, origin: originOf(req) })));
  }

  for (const name of DOC_PAGES) {
    app.get([`/${name}`, `/${name}.html`], (req, res) => sendHtml(res, renderer.renderDoc(name, { origin: originOf(req) })));
  }

  app.get('/manifest.webmanifest', (req, res) => {
    const lang = renderer.has(req.query.lang) ? req.query.lang : 'en';
    res.set('Content-Type', 'application/manifest+json; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(renderer.manifest(lang));
  });

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${originOf(req)}/sitemap.xml\n`);
  });

  app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml').send(renderer.sitemap(originOf(req)));
  });

  app.use(
    express.static(publicDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.woff2')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else if (/\.(png|ico|webp|jpg)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
        else if (filePath.endsWith('.svg')) res.setHeader('Cache-Control', 'public, max-age=86400');
        else res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      },
    }),
  );

  app.use((req, res) => {
    res.status(404);
    sendHtml(res, renderer.renderNotFound({ origin: originOf(req) }));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error(err);
    res.status(500).type('text/plain').send('Internal Server Error');
  });

  return app;
}
