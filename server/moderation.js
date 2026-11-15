// Reports and bans.
//
// A user is identified by up to three keys: "u:<userId>" (their account),
// "c:<clientId>" (random id stored in the browser) and "i:<ipHash>" (HMAC of
// the IP address — we never store raw IPs).
// When enough *different* people report the same key within a time window,
// both of the offender's keys are banned temporarily. Banning on both keys
// means clearing browser storage is not enough to come straight back.
//
// Many people worldwide share one public IP (mobile carrier-grade NAT, schools,
// offices), so the IP side is deliberately softer than the browser side:
//   • an IP ban lasts IP_BAN_HOURS (default 1h), the browser ban BAN_HOURS (24h)
//   • reports counted per IP need twice the threshold before they ban anyone
//   • the IP is never banned when the reporter shares it (same network)

import fs from 'node:fs';
import path from 'node:path';

export const clientKey = (clientId) => `c:${clientId}`;
export const ipKey = (ipHash) => `i:${ipHash}`;
export const userKey = (userId) => `u:${userId}`;
/** The strongest identity we have: the account if signed in, else the browser. */
export const primaryKey = ({ userId, clientId }) => (userId ? userKey(userId) : clientKey(clientId));

export class Moderation {
  /**
   * @param {{ threshold: number, windowMs: number, banMs: number, ipBanMs?: number, banIp?: boolean,
   *           store?: FileStore | null, now?: () => number, maxReports?: number }} opts
   */
  constructor({ threshold, windowMs, banMs, ipBanMs = 3_600_000, banIp = true, store = null, now = Date.now, maxReports = 2000 }) {
    this.threshold = threshold;
    this.windowMs = windowMs;
    this.banMs = banMs;
    this.ipBanMs = ipBanMs;
    this.banIp = banIp;
    this.store = store;
    this.now = now;
    this.maxReports = maxReports;
    /** @type {Map<string, { until: number, reason: string, source: string, createdAt: number }>} */
    this.bans = new Map(store?.loadBans() ?? []);
    /** @type {Map<string, Map<string, number>>} target key -> (reporter ip key -> last report time) */
    this.strikes = new Map();
    /** recent reports, newest last (for the admin API) */
    this.reports = [];
  }

  /** @returns {{ until: number, reason: string } | null} */
  isBanned({ clientId, ipHash, userId }) {
    const t = this.now();
    for (const key of [userId && userKey(userId), clientId && clientKey(clientId), this.banIp && ipHash && ipKey(ipHash)]) {
      if (!key) continue;
      const ban = this.bans.get(key);
      if (!ban) continue;
      if (ban.until > t) return { until: ban.until, reason: ban.reason };
      this.bans.delete(key);
      this.#persistBans();
    }
    return null;
  }

  ban(keys, { ms = this.banMs, reason = 'reports', source = 'auto' } = {}) {
    const t = this.now();
    const until = t + ms;
    for (const key of keys) {
      const existing = this.bans.get(key);
      if (existing && existing.until >= until) continue;
      this.bans.set(key, { until, reason, source, createdAt: t });
    }
    this.#persistBans();
    return until;
  }

  unban(key) {
    const removed = this.bans.delete(key);
    if (removed) this.#persistBans();
    return removed;
  }

  listBans() {
    const t = this.now();
    return [...this.bans]
      .filter(([, ban]) => ban.until > t)
      .map(([key, ban]) => ({ key, ...ban }));
  }

  listReports(limit = 100) {
    return this.reports.slice(-limit).reverse();
  }

  /**
   * @param {{ reporter: { clientId: string, ipHash: string },
   *           target: { clientId: string, ipHash: string, country?: string | null },
   *           reason: string, transcript?: Array<{ from: string, text: string, at: number }>,
   *           mode?: string }} report
   * @returns {{ banned: boolean, until?: number, strikes: number }}
   *   On a ban, the caller should disconnect the offender's browser (client key) only —
   *   not everyone behind the same IP.
   */
  report({ reporter, target, reason, transcript = [], mode }) {
    const t = this.now();
    const record = {
      id: `${t.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date(t).toISOString(),
      reason,
      mode,
      reporter: { userId: reporter.userId ?? null, clientId: reporter.clientId, ipHash: reporter.ipHash },
      target: { userId: target.userId ?? null, clientId: target.clientId, ipHash: target.ipHash, country: target.country ?? null },
      transcript: transcript.slice(-20),
    };
    this.reports.push(record);
    if (this.reports.length > this.maxReports) this.reports.splice(0, this.reports.length - this.maxReports);
    this.store?.appendReport(record);

    const sameNetwork = reporter.ipHash === target.ipHash;
    const cKey = primaryKey(target); // the account when signed in, else the browser
    const iKey = ipKey(target.ipHash);
    // Count distinct reporters by IP so one person with many tabs counts once.
    const reporterId = ipKey(reporter.ipHash);
    const strike = (key) => {
      let byReporter = this.strikes.get(key);
      if (!byReporter) this.strikes.set(key, (byReporter = new Map()));
      byReporter.set(reporterId, t);
      for (const [id, at] of byReporter) if (t - at > this.windowMs) byReporter.delete(id);
      return byReporter.size;
    };
    const clientStrikes = strike(cKey);
    const ipStrikes = this.banIp && !sameNetwork ? strike(iKey) : 0;
    const strikes = Math.max(clientStrikes, ipStrikes);

    if (clientStrikes >= this.threshold || ipStrikes >= this.threshold * 2) {
      const until = this.ban(target.userId ? [cKey, clientKey(target.clientId)] : [cKey], { reason: 'reports', source: 'auto' });
      if (this.banIp && !sameNetwork) this.ban([iKey], { ms: this.ipBanMs, reason: 'reports', source: 'auto' });
      this.strikes.delete(cKey);
      this.strikes.delete(iKey);
      return { banned: true, until, strikes };
    }
    return { banned: false, strikes };
  }

  /** Forget stale strike counters. Call periodically. */
  sweep() {
    const t = this.now();
    for (const [key, byReporter] of this.strikes) {
      for (const [id, at] of byReporter) if (t - at > this.windowMs) byReporter.delete(id);
      if (!byReporter.size) this.strikes.delete(key);
    }
    let changed = false;
    for (const [key, ban] of this.bans) {
      if (ban.until <= t) {
        this.bans.delete(key);
        changed = true;
      }
    }
    if (changed) this.#persistBans();
  }

  #persistBans() {
    this.store?.saveBans([...this.bans]);
  }
}

/**
 * Durable storage in DATA_DIR: bans.json (rewritten on change, debounced) and
 * reports.jsonl (append-only). Failures are logged once and otherwise ignored
 * so a read-only filesystem never takes the chat down.
 */
export class FileStore {
  constructor(dir, { logger = console } = {}) {
    this.dir = path.resolve(dir);
    this.logger = logger;
    this.warned = false;
    this.saveTimer = null;
    this.pendingBans = null;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      this.#warn(err);
    }
  }

  get bansFile() {
    return path.join(this.dir, 'bans.json');
  }

  get reportsFile() {
    return path.join(this.dir, 'reports.jsonl');
  }

  loadBans() {
    try {
      const entries = JSON.parse(fs.readFileSync(this.bansFile, 'utf8'));
      return Array.isArray(entries) ? entries.filter((e) => Array.isArray(e) && typeof e[0] === 'string') : [];
    } catch (err) {
      if (err.code !== 'ENOENT') this.#warn(err);
      return [];
    }
  }

  saveBans(entries) {
    this.pendingBans = entries;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 500);
    this.saveTimer.unref?.();
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.pendingBans) return;
    const entries = this.pendingBans;
    this.pendingBans = null;
    try {
      const tmp = `${this.bansFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries));
      fs.renameSync(tmp, this.bansFile);
    } catch (err) {
      this.#warn(err);
    }
  }

  appendReport(record) {
    fs.appendFile(this.reportsFile, JSON.stringify(record) + '\n', (err) => err && this.#warn(err));
  }

  #warn(err) {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(`[moderation] storage unavailable (${err.message}); continuing in memory only`);
  }
}
