// Real-time layer: one Socket.IO connection per browser tab.
//
// Client -> server events
//   find    { mode, interests, langOnly, lang }  (ack)  start searching / skip to next
//   stop                                                leave the queue or current chat
//   signal  { pairId, kind: 'sdp'|'ice'|'media', … }    WebRTC signalling, relayed to the partner
//   message { pairId, text }                     (ack)  text chat, relayed to the partner
//   typing  { pairId, on }
//   report  { pairId?, reason }                  (ack)  report current or just-left partner
//
// Server -> client events
//   hello { iceServers, iceTransportPolicy, country, online, clientId }
//   stats { online }
//   matched { pairId, initiator, mode, partner: { country, lang }, shared }
//   signal | message | typing   (relayed, always tagged with pairId)
//   partner_left { pairId, reason: 'skipped'|'left'|'disconnected' }
//   banned { until }
//
// Video and audio never touch the server: browsers connect peer-to-peer (or
// through TURN). The server only introduces people and relays small messages.

import crypto from 'node:crypto';
import { Matchmaker } from './matchmaker.js';
import { clientKey, ipKey, primaryKey, userKey } from './moderation.js';
import { KeyedLimiter, TokenBucket } from './rate-limit.js';
import { REPORT_REASONS, cleanInterests, cleanLang, cleanMessage, cleanSignal, isUuid } from './sanitize.js';
import { detectCountry } from './geo.js';
import { sessionUserId } from './auth.js';
import { GUIDELINES_VERSION } from './users.js';

const TRANSCRIPT_SIZE = 30;

function connectError(code, extra = {}) {
  const err = new Error(code);
  err.data = { code, ...extra };
  return err;
}

const noop = () => {};

/**
 * @param {import('socket.io').Server} io
 * @param {{ config: any, ice: import('./ice.js').IceProvider, moderation: import('./moderation.js').Moderation,
 *           users: import('./users.js').UserStore, ipHashOf: (req: any) => string,
 *           logger?: Console, now?: () => number }} deps
 */
export function attachChat(io, { config, ice, moderation, users, ipHashOf, logger = console, now = Date.now }) {
  const matchmaker = new Matchmaker({ interestWaitMs: config.matching.interestWaitMs, now });
  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** @type {Map<string, any>} */
  const pairs = new Map();
  const connectionLimiter = new KeyedLimiter({
    capacity: config.limits.connectionsPerMinute,
    refillPerSec: config.limits.connectionsPerMinute / 60,
    now,
  });

  // ---------------------------------------------------------------- handshake
  // Anyone may connect (the landing page shows the live count); the session
  // cookie, if present, tells us which account this is.
  io.use((socket, next) => {
    const req = socket.request;
    const ipHash = ipHashOf(req);
    if (!connectionLimiter.take(ipHash)) return next(connectError('rate_limited'));

    const auth = socket.handshake.auth || {};
    const clientId = isUuid(auth.clientId) ? auth.clientId.toLowerCase() : crypto.randomUUID();
    const userId = users.get(sessionUserId(req, config.secret))?.id ?? null;
    const ban = moderation.isBanned({ clientId, ipHash, userId });
    if (ban) return next(connectError('banned', { until: ban.until }));

    socket.data.identity = {
      clientId,
      ipHash,
      userId,
      country: detectCountry(req.headers, typeof auth.tz === 'string' ? auth.tz : undefined),
      lang: cleanLang(auth.lang) || 'en',
    };
    next();
  });

  // --------------------------------------------------------------- helpers
  const other = (pair, s) => (pair.a === s ? pair.b : pair.a);

  // keys[0] is the person (account or browser); all keys are checked against avoid lists.
  const keysOf = (x) => [...new Set([primaryKey(x), clientKey(x.clientId), ipKey(x.ipHash)])];

  function candidateOf(s) {
    return {
      id: s.id,
      keys: keysOf(s),
      mode: s.prefs.mode,
      interests: s.prefs.interests,
      lang: s.lang,
      langOnly: s.prefs.langOnly,
      avoid: s.avoid,
    };
  }

  function enqueue(s) {
    s.state = 'waiting';
    const match = matchmaker.enqueue(candidateOf(s));
    if (match) startPair(match.a.id, match.b.id, match.shared);
  }

  function startPair(aId, bId, shared) {
    const a = sessions.get(aId);
    const b = sessions.get(bId);
    if (!a || !b || a.state !== 'waiting' || b.state !== 'waiting') {
      for (const s of [a, b]) if (s && s.state === 'waiting' && !matchmaker.has(s.id)) enqueue(s);
      return;
    }
    const pair = { id: crypto.randomUUID(), a, b, mode: a.prefs.mode, startedAt: now(), transcript: [] };
    pairs.set(pair.id, pair);
    a.pair = b.pair = pair;
    a.state = b.state = 'paired';
    const view = (s) => ({ country: s.country, lang: s.lang });
    // The person who waited longer creates the WebRTC offer.
    a.socket.emit('matched', { pairId: pair.id, initiator: true, mode: pair.mode, partner: view(b), shared });
    b.socket.emit('matched', { pairId: pair.id, initiator: false, mode: pair.mode, partner: view(a), shared });
  }

  function rememberPartner(me, partner, pair) {
    const key = primaryKey(partner);
    const limit = config.matching.recentPartners;
    if (limit > 0) {
      me.recent.push(key);
      me.avoid.add(key);
      while (me.recent.length > limit) {
        const old = me.recent.shift();
        if (!me.blocked.has(old) && !me.recent.includes(old)) me.avoid.delete(old);
      }
    }
    me.last = {
      userId: partner.userId,
      clientId: partner.clientId,
      ipHash: partner.ipHash,
      country: partner.country,
      pairId: pair.id,
      mode: pair.mode,
      endedAt: now(),
      pair,
      reported: false,
    };
  }

  /** Ends the chat `s` is in. The partner is told why (never that they were reported). */
  function endPair(s, reason) {
    const pair = s.pair;
    if (!pair) return;
    const partner = other(pair, s);
    pairs.delete(pair.id);
    for (const [me, them] of [
      [s, partner],
      [partner, s],
    ]) {
      me.pair = null;
      me.state = 'idle';
      rememberPartner(me, them, pair);
    }
    partner.socket.emit('partner_left', { pairId: pair.id, reason });
  }

  function transcriptFor(pair, viewer) {
    if (!pair) return [];
    return pair.transcript.map((m) => ({ from: m.by === viewer.id ? 'reporter' : 'reported', text: m.text, at: m.at }));
  }

  /**
   * Disconnects every live session matching one of `keys` ("c:<clientId>" or
   * "i:<ipHash>") after a ban.
   */
  function kick(keys, until) {
    const wanted = new Set(keys);
    for (const s of sessions.values()) {
      if (!keysOf(s).some((key) => wanted.has(key)) && !(s.userId && wanted.has(userKey(s.userId)))) continue;
      matchmaker.remove(s.id);
      if (s.pair) endPair(s, 'left');
      s.state = 'idle';
      s.socket.emit('banned', { until });
      s.socket.disconnect(true);
    }
  }

  function stats(full = false) {
    const base = { online: sessions.size };
    if (!full) return base;
    return { ...base, waiting: matchmaker.countByMode(), chats: pairs.size };
  }

  // ------------------------------------------------------------ connection
  io.on('connection', (socket) => {
    const s = {
      id: socket.id,
      socket,
      ...socket.data.identity,
      state: 'idle', // idle | waiting | paired
      prefs: { mode: 'video', interests: [], langOnly: false },
      pair: null,
      avoid: new Set(),
      blocked: new Set(),
      recent: [],
      last: null,
      limits: {
        find: new TokenBucket({ capacity: 10, refillPerSec: 0.7, now }),
        message: new TokenBucket({ capacity: 8, refillPerSec: 1, now }),
        typing: new TokenBucket({ capacity: 10, refillPerSec: 2, now }),
        signal: new TokenBucket({ capacity: 400, refillPerSec: 25, now }),
        report: new TokenBucket({ capacity: 5, refillPerSec: 1 / 120, now }),
      },
    };
    sessions.set(s.id, s);

    ice
      .serversFor(socket.id)
      .catch(() => [])
      .then((iceServers) => {
        if (!socket.connected) return;
        socket.emit('hello', {
          iceServers,
          iceTransportPolicy: config.ice.forceRelay ? 'relay' : 'all',
          country: s.country,
          online: sessions.size,
          clientId: s.clientId,
        });
      });

    socket.on('find', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : noop;
      if (!s.limits.find.take()) return reply({ ok: false, error: 'rate_limited' });
      if (config.auth.required) {
        // Matching needs an account that agreed to the current guidelines.
        const user = users.get(s.userId);
        if (!user) return reply({ ok: false, error: 'auth_required' });
        if (user.guidelinesVersion !== GUIDELINES_VERSION) return reply({ ok: false, error: 'guidelines_required' });
      }
      const mode = payload?.mode === 'text' ? 'text' : payload?.mode === 'video' ? 'video' : null;
      if (!mode) return reply({ ok: false, error: 'invalid' });
      s.prefs = {
        mode,
        interests: cleanInterests(payload.interests, {
          max: config.limits.maxInterests,
          maxLength: config.limits.maxInterestLength,
        }),
        langOnly: payload.langOnly === true,
      };
      s.lang = cleanLang(payload.lang) || s.lang;
      if (s.pair) endPair(s, 'skipped');
      reply({ ok: true });
      enqueue(s);
    });

    socket.on('stop', () => {
      matchmaker.remove(s.id);
      if (s.pair) endPair(s, 'left');
      s.state = 'idle';
    });

    socket.on('signal', (payload) => {
      const pair = s.pair;
      if (!pair || pair.mode !== 'video') return;
      const data = cleanSignal(payload);
      if (!data || data.pairId !== pair.id || !s.limits.signal.take()) return;
      other(pair, s).socket.emit('signal', data);
    });

    socket.on('message', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : noop;
      const pair = s.pair;
      if (!pair || payload?.pairId !== pair.id) return reply({ ok: false, error: 'not_paired' });
      if (!s.limits.message.take()) return reply({ ok: false, error: 'rate_limited' });
      const cleaned = cleanMessage(payload.text, { maxLength: config.limits.maxMessageLength });
      if (!cleaned) return reply({ ok: false, error: 'invalid' });
      if (cleaned.hasLink && config.moderation.blockLinks) return reply({ ok: false, error: 'links_blocked' });
      const at = now();
      pair.transcript.push({ by: s.id, text: cleaned.text, at });
      if (pair.transcript.length > TRANSCRIPT_SIZE) pair.transcript.shift();
      other(pair, s).socket.emit('message', { pairId: pair.id, text: cleaned.text, at });
      reply({ ok: true, text: cleaned.text, at });
    });

    socket.on('typing', (payload) => {
      const pair = s.pair;
      if (!pair || payload?.pairId !== pair.id || !s.limits.typing.take()) return;
      other(pair, s).socket.emit('typing', { pairId: pair.id, on: payload.on === true });
    });

    socket.on('report', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : noop;
      const reason = typeof payload?.reason === 'string' && REPORT_REASONS.has(payload.reason) ? payload.reason : null;
      if (!reason) return reply({ ok: false, error: 'invalid' });
      const pairId = typeof payload.pairId === 'string' ? payload.pairId : null;

      if (s.pair && (!pairId || pairId === s.pair.id)) {
        endPair(s, 'left'); // also records the partner in s.last
      }
      const target = s.last;
      const recent = target && now() - target.endedAt <= config.moderation.lastPartnerReportMs;
      if (!target || !recent || (pairId && pairId !== target.pairId)) return reply({ ok: false, error: 'no_target' });
      if (target.reported) return reply({ ok: true });
      if (!s.limits.report.take()) return reply({ ok: false, error: 'rate_limited' });
      target.reported = true;

      // The reporter never meets this person (account, device or network) again.
      for (const key of keysOf(target)) {
        s.blocked.add(key);
        s.avoid.add(key);
      }

      const result = moderation.report({
        reporter: { userId: s.userId, clientId: s.clientId, ipHash: s.ipHash },
        target: { userId: target.userId, clientId: target.clientId, ipHash: target.ipHash, country: target.country },
        reason,
        mode: target.mode,
        transcript: transcriptFor(target.pair, s),
      });
      if (result.banned) {
        logger.info?.(`[moderation] auto-ban after ${result.strikes} reports`);
        // Only the offender (account + browser) is disconnected; an IP ban (if
        // any) just stops new connections for a short while.
        kick([primaryKey(target), clientKey(target.clientId)], result.until);
      }
      reply({ ok: true });
    });

    socket.on('disconnect', () => {
      matchmaker.remove(s.id);
      if (s.pair) endPair(s, 'disconnected');
      sessions.delete(s.id);
    });
  });

  // ---------------------------------------------------------------- timers
  const timers = [
    setInterval(() => {
      for (const m of matchmaker.tick()) startPair(m.a.id, m.b.id, m.shared);
    }, config.matching.tickMs),
    setInterval(() => io.emit('stats', stats()), 5000),
    setInterval(() => {
      connectionLimiter.sweep();
      moderation.sweep();
    }, 60_000),
  ];
  for (const t of timers) t.unref?.();

  return {
    stats,
    kick,
    sessions,
    pairs,
    matchmaker,
    close() {
      for (const t of timers) clearInterval(t);
    },
  };
}
