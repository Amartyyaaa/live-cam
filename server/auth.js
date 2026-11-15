// Sign-in: signed session cookies, email + password, and "Sign in with Google".
//
// Sessions are stateless: the cookie holds {uid, exp} plus an HMAC made with
// SERVER_SECRET, so nothing has to be stored per login. The cookie is
// HttpOnly + SameSite=Lax (and Secure over HTTPS), which also protects the
// POST endpoints below from cross-site requests.

import crypto from 'node:crypto';
import express from 'express';
import { KeyedLimiter } from './rate-limit.js';
import { AuthError, publicUser } from './users.js';

export const SESSION_COOKIE = 'hiyo_session';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signSession(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifySession(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.uid !== 'string' || typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Reads the session cookie of an HTTP request (or a Socket.IO handshake). */
export function sessionUserId(req, secret) {
  const token = readCookie(req.headers?.cookie, SESSION_COOKIE);
  return token ? verifySession(token, secret)?.uid ?? null : null;
}

// ------------------------------------------------------------------ Google

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';

/**
 * Verifies ID tokens from Google Identity Services ("Sign in with Google")
 * with Google's public keys — no SDK needed.
 */
export class GoogleVerifier {
  constructor({ clientId, fetch: fetchImpl = globalThis.fetch, now = Date.now }) {
    this.clientId = clientId;
    this.fetch = fetchImpl;
    this.now = now;
    this.keys = null; // { byKid: Map, expiresAt }
  }

  async #jwks(force = false) {
    if (!force && this.keys && this.keys.expiresAt > this.now()) return this.keys.byKid;
    const res = await this.fetch(GOOGLE_CERTS, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Google certs HTTP ${res.status}`);
    const body = await res.json();
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers?.get?.('cache-control') || '')?.[1] || 3600);
    const byKid = new Map((body.keys || []).map((jwk) => [jwk.kid, jwk]));
    this.keys = { byKid, expiresAt: this.now() + Math.min(maxAge, 86400) * 1000 };
    return byKid;
  }

  async verify(idToken) {
    if (!this.clientId) throw new AuthError('google_disabled');
    const parts = typeof idToken === 'string' ? idToken.split('.') : [];
    if (parts.length !== 3) throw new AuthError('google');
    let header;
    let payload;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new AuthError('google');
    }
    if (header.alg !== 'RS256' || !header.kid) throw new AuthError('google');
    let jwk = (await this.#jwks()).get(header.kid);
    if (!jwk) jwk = (await this.#jwks(true)).get(header.kid); // keys rotate
    if (!jwk) throw new AuthError('google');

    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const valid = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], 'base64url'),
    );
    const nowSec = this.now() / 1000;
    const audOk = Array.isArray(payload.aud) ? payload.aud.includes(this.clientId) : payload.aud === this.clientId;
    if (!valid || !GOOGLE_ISSUERS.has(payload.iss) || !audOk || !(payload.exp > nowSec - 60) || !payload.sub) {
      throw new AuthError('google');
    }
    return {
      sub: String(payload.sub),
      email: payload.email_verified === true || payload.email_verified === 'true' ? payload.email : null,
      name: payload.name || payload.given_name || '',
      picture: payload.picture || null,
    };
  }
}

// ------------------------------------------------------------------ routes

/**
 * /api/me, /api/auth/*, /api/me/guidelines
 * @param {{ config: any, users: import('./users.js').UserStore, moderation: any, google: GoogleVerifier,
 *           clientKeyOf: (req: any) => string, logger?: Console }} deps
 */
export function createAuthRouter({ config, users, moderation, google, clientKeyOf, logger = console }) {
  const router = express.Router();
  const limiter = new KeyedLimiter({
    capacity: config.auth.attemptsPerMinute,
    refillPerSec: config.auth.attemptsPerMinute / 60,
  });
  const maxAge = config.auth.sessionDays * 86400;

  router.use(express.json({ limit: '10kb' }));

  // Same-origin only for anything that changes state (defence in depth on top of SameSite).
  router.use((req, res, next) => {
    if (req.method === 'GET') return next();
    const origin = req.get('origin');
    if (origin) {
      let host = null;
      try {
        host = new URL(origin).host;
      } catch {
        /* invalid origin */
      }
      if (host !== req.get('host')) return res.status(403).json({ error: 'forbidden' });
    }
    if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' });
    next();
  });

  const setSession = (req, res, user) => {
    const now = Math.floor(Date.now() / 1000);
    const token = signSession({ uid: user.id, iat: now, exp: now + maxAge }, config.secret);
    res.append(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`,
    );
  };
  const clearSession = (req, res) =>
    res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`);

  const currentUser = (req) => users.get(sessionUserId(req, config.secret));
  const limited = (req, res) => {
    if (limiter.take(clientKeyOf(req))) return false;
    res.status(429).json({ error: 'rate_limited' });
    return true;
  };
  const bannedResponse = (res, user) => {
    const ban = moderation.isBanned({ userId: user.id });
    if (!ban) return false;
    res.status(403).json({ error: 'banned', until: ban.until });
    return true;
  };
  const fail = (res, err) => {
    if (err instanceof AuthError) return res.status(err.code === 'invalid' ? 401 : 400).json({ error: err.code });
    logger.error(err);
    return res.status(500).json({ error: 'generic' });
  };

  router.get('/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      user: publicUser(currentUser(req)),
      google: config.auth.googleClientId || null,
      email: config.auth.allowEmail,
      required: config.auth.required,
    });
  });

  router.post('/auth/signup', async (req, res) => {
    if (limited(req, res)) return;
    if (!config.auth.allowEmail) return res.status(403).json({ error: 'email_disabled' });
    try {
      const user = await users.createWithPassword(req.body || {});
      setSession(req, res, user);
      res.status(201).json({ user: publicUser(user) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/auth/login', async (req, res) => {
    if (limited(req, res)) return;
    if (!config.auth.allowEmail) return res.status(403).json({ error: 'email_disabled' });
    try {
      const { email, password } = req.body || {};
      const user = await users.checkPassword(email, password);
      if (!user) throw new AuthError('invalid');
      if (bannedResponse(res, user)) return;
      users.touch(user.id);
      setSession(req, res, user);
      res.json({ user: publicUser(user) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/auth/google', async (req, res) => {
    if (limited(req, res)) return;
    try {
      const identity = await google.verify(req.body?.credential);
      const user = users.upsertGoogle(identity);
      if (bannedResponse(res, user)) return;
      setSession(req, res, user);
      res.json({ user: publicUser(user) });
    } catch (err) {
      if (!(err instanceof AuthError)) logger.warn(`[auth] Google sign-in failed: ${err.message}`);
      res.status(401).json({ error: err instanceof AuthError ? err.code : 'google' });
    }
  });

  router.post('/auth/logout', (req, res) => {
    clearSession(req, res);
    res.json({ ok: true });
  });

  router.post('/me/guidelines', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'auth_required' });
    if (req.body?.age !== true || req.body?.terms !== true) return res.status(400).json({ error: 'required' });
    res.json({ user: publicUser(users.acceptGuidelines(user.id)) });
  });

  return router;
}
