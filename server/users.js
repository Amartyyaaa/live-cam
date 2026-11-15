// User accounts.
//
// Kept deliberately small: a JSON file in DATA_DIR (no database to install).
// It comfortably handles tens of thousands of accounts on one server; for
// more, or several servers, move this class onto Postgres — every caller goes
// through the methods below.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Bump when the Terms / Guidelines change: everyone is asked to agree again. */
export const GUIDELINES_VERSION = 1;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

function scrypt(password, salt, keylen, opts) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  return email;
}

export function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const name = Array.from(value.normalize('NFC').replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim())
    .slice(0, 40)
    .join('')
    .trim();
  return name || null;
}

/** What the browser may see about its own account (never the password hash). */
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    picture: user.picture || null,
    provider: user.provider,
    guidelinesAccepted: user.guidelinesVersion === GUIDELINES_VERSION,
  };
}

export class AuthError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export class UserStore {
  /** @param {{ file?: string | null, logger?: Pick<Console, 'warn'>, now?: () => number }} [opts] */
  constructor({ file = null, logger = console, now = Date.now } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.logger = logger;
    this.now = now;
    this.byId = new Map();
    this.byEmail = new Map();
    this.byGoogle = new Map();
    this.saveTimer = null;
    this.warned = false;
    this.#load();
  }

  get size() {
    return this.byId.size;
  }

  get(id) {
    return (typeof id === 'string' && this.byId.get(id)) || null;
  }

  findByEmail(email) {
    const normalized = normalizeEmail(email);
    return (normalized && this.byEmail.get(normalized)) || null;
  }

  async createWithPassword({ name, email, password }) {
    const cleanName = normalizeName(name);
    const cleanEmail = normalizeEmail(email);
    if (!cleanName) throw new AuthError('name');
    if (!cleanEmail) throw new AuthError('email');
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new AuthError('weak');
    if (this.byEmail.has(cleanEmail)) throw new AuthError('exists');
    const passwordHash = await hashPassword(password);
    // Check again after the (async) hashing: two sign-ups may have raced.
    if (this.byEmail.has(cleanEmail)) throw new AuthError('exists');
    return this.#create({ name: cleanName, email: cleanEmail, provider: 'email', passwordHash });
  }

  async checkPassword(email, password) {
    const user = this.findByEmail(email);
    // Hash anyway when the account doesn't exist, so timing doesn't reveal which emails are registered.
    const ok = await verifyPassword(typeof password === 'string' ? password : '', user?.passwordHash ?? DUMMY_HASH);
    return ok && user?.passwordHash ? user : null;
  }

  /** Signs in (or creates) the account behind a verified Google identity. */
  upsertGoogle({ sub, email, name, picture }) {
    let user = this.byGoogle.get(sub);
    const cleanEmail = normalizeEmail(email);
    if (!user && cleanEmail) {
      // Same verified email as an existing account: link it. Email sign-ups aren't verified, so whoever chose
      // that password may not own the address — Google just proved who does, so the password stops working.
      user = this.byEmail.get(cleanEmail) ?? null;
      if (user) {
        user.googleSub = sub;
        if (user.passwordHash) {
          delete user.passwordHash;
          user.provider = 'google';
        }
      }
    }
    if (!user) {
      user = this.#create({
        name: normalizeName(name) || cleanEmail?.split('@')[0] || 'Friend',
        email: cleanEmail,
        provider: 'google',
        googleSub: sub,
      });
    }
    if (typeof picture === 'string' && /^https:\/\/[\w.-]+\.googleusercontent\.com\//.test(picture)) user.picture = picture;
    this.#index(user);
    this.touch(user.id);
    return user;
  }

  acceptGuidelines(id) {
    const user = this.get(id);
    if (!user) return null;
    user.guidelinesVersion = GUIDELINES_VERSION;
    user.guidelinesAcceptedAt = new Date(this.now()).toISOString();
    this.#save();
    return user;
  }

  touch(id) {
    const user = this.get(id);
    if (!user) return;
    user.lastLoginAt = new Date(this.now()).toISOString();
    this.#save();
  }

  /** Newest first, without secrets — for the admin API. */
  list(limit = 100) {
    return [...this.byId.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map(({ passwordHash, googleSub, ...rest }) => rest);
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ users: [...this.byId.values()] }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.#warn(err);
    }
  }

  #create(fields) {
    const user = {
      id: crypto.randomUUID(),
      createdAt: new Date(this.now()).toISOString(),
      lastLoginAt: new Date(this.now()).toISOString(),
      guidelinesVersion: 0,
      picture: null,
      ...fields,
    };
    this.#index(user);
    this.#save();
    return user;
  }

  #index(user) {
    this.byId.set(user.id, user);
    if (user.email && !this.byEmail.has(user.email)) this.byEmail.set(user.email, user);
    if (user.googleSub) this.byGoogle.set(user.googleSub, user);
  }

  #load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const user of data.users ?? []) if (user?.id) this.#index(user);
    } catch (err) {
      if (err.code !== 'ENOENT') this.#warn(err);
    }
  }

  #save() {
    this.dirty = true;
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 300);
    this.saveTimer.unref?.();
  }

  #warn(err) {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(`[users] storage unavailable (${err.message}); accounts are kept in memory only`);
  }
}

// A valid hash of a random password, used to keep login timing constant.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
