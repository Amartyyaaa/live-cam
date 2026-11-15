// Central configuration. Everything is driven by environment variables so the
// same build can run locally, in Docker, or on any PaaS. See .env.example.

import crypto from 'node:crypto';

function readInt(env, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function readBool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function readList(env, name, fallback = []) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Express "trust proxy" setting. The default trusts only proxies on private /
// loopback networks, which covers nginx/Caddy on the same machine and most PaaS
// load balancers (Render, Fly, Heroku…) without letting the public spoof
// X-Forwarded-For when the app is exposed directly.
function readTrustProxy(env) {
  const raw = (env.TRUST_PROXY ?? '').trim();
  if (raw === '') return 'loopback, linklocal, uniquelocal';
  if (/^(true|yes|on)$/i.test(raw)) return true;
  if (/^(false|no|off)$/i.test(raw)) return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

export function loadConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  return {
    isProduction,
    port: readInt(env, 'PORT', 3000, { min: 0, max: 65535 }),
    host: env.HOST || '0.0.0.0',

    // Branding — rename the product without touching code.
    appName: env.APP_NAME || 'Hiyo',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    contactEmail: env.CONTACT_EMAIL || 'support@example.com',
    allowedOrigins: readList(env, 'ALLOWED_ORIGINS'),

    trustProxy: readTrustProxy(env),
    // Header carrying the visitor's IP when behind a CDN, e.g. "cf-connecting-ip"
    // (Cloudflare) or "fly-client-ip". Only set it if the CDN is the sole way in.
    clientIpHeader: (env.CLIENT_IP_HEADER || '').trim().toLowerCase(),
    dataDir: env.DATA_DIR || 'data',
    // Used to hash IP addresses for moderation. Set it in production so bans
    // survive restarts; a random one is generated otherwise.
    secret: env.SERVER_SECRET || crypto.randomBytes(32).toString('hex'),
    secretIsEphemeral: !env.SERVER_SECRET,
    adminToken: env.ADMIN_TOKEN || '',

    ice: {
      stunUrls: readList(env, 'STUN_URLS', ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']),
      turnUrls: readList(env, 'TURN_URLS'),
      turnUsername: env.TURN_USERNAME || '',
      turnCredential: env.TURN_CREDENTIAL || '',
      // coturn "use-auth-secret" (TURN REST API) — preferred over static creds.
      turnSecret: env.TURN_SECRET || '',
      turnTtl: readInt(env, 'TURN_TTL', 12 * 3600, { min: 300, max: 7 * 86400 }),
      // Cloudflare Realtime TURN (https://developers.cloudflare.com/realtime/turn/)
      cloudflareKeyId: env.CLOUDFLARE_TURN_KEY_ID || '',
      cloudflareApiToken: env.CLOUDFLARE_TURN_API_TOKEN || '',
      // Route all media through TURN so peers never see each other's IP.
      forceRelay: readBool(env, 'FORCE_RELAY', false),
    },

    auth: {
      // Users must sign in (and accept the guidelines) before chatting.
      required: readBool(env, 'REQUIRE_SIGN_IN', true),
      // OAuth client ID from Google Cloud Console → enables "Sign in with Google".
      googleClientId: (env.GOOGLE_CLIENT_ID || '').trim(),
      allowEmail: readBool(env, 'ALLOW_EMAIL_SIGNUP', true),
      sessionDays: readInt(env, 'SESSION_DAYS', 30, { min: 1, max: 365 }),
      attemptsPerMinute: readInt(env, 'AUTH_ATTEMPTS_PER_MINUTE', 10, { min: 1, max: 100000 }),
    },

    matching: {
      // How long someone with interests waits for a shared-interest match
      // before we fall back to a random stranger (Omegle-style).
      interestWaitMs: readInt(env, 'INTEREST_WAIT_MS', 5000, { min: 0, max: 120000 }),
      tickMs: 1000,
      recentPartners: readInt(env, 'RECENT_PARTNERS', 25, { min: 0, max: 500 }),
    },

    moderation: {
      reportThreshold: readInt(env, 'REPORT_THRESHOLD', 3, { min: 1, max: 100 }),
      reportWindowMs: readInt(env, 'REPORT_WINDOW_MINUTES', 60, { min: 1, max: 10080 }) * 60_000,
      banMs: readInt(env, 'BAN_HOURS', 24, { min: 1, max: 24 * 365 }) * 3_600_000,
      // Also ban the (hashed) IP address, not just the browser. Disable in
      // regions where many people share one IP via carrier-grade NAT.
      banIp: readBool(env, 'BAN_IP', true),
      ipBanMs: readInt(env, 'IP_BAN_HOURS', 1, { min: 1, max: 24 * 30 }) * 3_600_000,
      blockLinks: readBool(env, 'BLOCK_LINKS', true),
      lastPartnerReportMs: 2 * 60_000,
    },

    limits: {
      maxMessageLength: 500,
      maxInterests: 10,
      maxInterestLength: 24,
      connectionsPerMinute: readInt(env, 'CONNECTIONS_PER_MINUTE', 120, { min: 1, max: 100000 }),
    },
  };
}
