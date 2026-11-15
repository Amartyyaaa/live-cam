// Input validation for everything that arrives from browsers.

// C0/C1 control characters (except \n), bidi embedding/override/isolate
// controls, and the BOM. Zero-width joiners are kept — emoji need them.
const CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩﻿]/g;

const TLDS = [
  'com', 'net', 'org', 'info', 'biz', 'io', 'co', 'me', 'ly', 'gg', 'tv', 'cc', 'xyz', 'top', 'site',
  'online', 'club', 'app', 'live', 'link', 'shop', 'store', 'fun', 'vip', 'win', 'bet', 'chat', 'page',
  'dev', 'ru', 'su', 'tk', 'ml', 'ga', 'cf', 'gq', 'pw', 'ws', 'in', 'uk', 'de', 'fr', 'br', 'es', 'it',
  'nl', 'pl', 'tr', 'ua', 'id', 'vn', 'ph', 'my', 'sg', 'jp', 'kr', 'cn', 'hk', 'tw', 'us', 'ca', 'au',
  'nz', 'za', 'ng', 'ke', 'eg', 'sa', 'ae', 'ir', 'pk', 'bd', 'mx', 'ar', 'cl', 'pe', 've', 'onlyfans',
].join('|');

// Matches URLs ("https://…", "www.…") and bare domains ("bit.ly/x", "t.me/x",
// "site[.]com"). Spam bots are the main abusers of anonymous chat.
const LINK_PATTERN = new RegExp(
  String.raw`(?:https?:\/\/|www\.)\S+|(?:^|[^\p{L}\p{N}@_-])[\p{L}\p{N}][\p{L}\p{N}-]{0,62}(?:\.|\[\.\]|\(\.\))(?:${TLDS})(?![\p{L}\p{N}])`,
  'iu',
);

export function containsLink(text) {
  return LINK_PATTERN.test(text);
}

/**
 * Normalises a chat message. Returns null when nothing printable is left.
 * @returns {{ text: string, hasLink: boolean } | null}
 */
export function cleanMessage(input, { maxLength = 500 } = {}) {
  if (typeof input !== 'string') return null;
  let text = input
    .slice(0, maxLength * 4)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL_CHARS, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const chars = Array.from(text);
  if (chars.length > maxLength) text = chars.slice(0, maxLength).join('').trim();
  if (!text) return null;
  return { text, hasLink: containsLink(text) };
}

/** Lower-cases, trims and de-duplicates interest tags. */
export function cleanInterests(input, { max = 10, maxLength = 24 } = {}) {
  if (!Array.isArray(input)) return [];
  const out = new Set();
  for (const item of input.slice(0, max * 3)) {
    if (typeof item !== 'string') continue;
    let tag = item
      .slice(0, maxLength * 4)
      .normalize('NFKC')
      .toLowerCase()
      .replace(CONTROL_CHARS, '')
      .replace(/[#,;\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    tag = Array.from(tag).slice(0, maxLength).join('').trim();
    if (tag) out.add(tag);
    if (out.size >= max) break;
  }
  return [...out];
}

/** "pt-BR" -> "pt". Returns null for anything that is not a language tag. */
export function cleanLang(input) {
  if (typeof input !== 'string') return null;
  const match = /^([a-z]{2,3})(?:[-_][a-z0-9]{1,8})*$/i.exec(input.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Normalises an IP for rate limiting and bans. IPv6 users usually control a
 * whole /64, so we bucket by that prefix — otherwise anyone could dodge an IP
 * ban by picking a new address from their own block.
 */
export function ipBucket(raw) {
  if (typeof raw !== 'string' || !raw) return 'unknown';
  let ip = raw.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

export const REPORT_REASONS = new Set(['nudity', 'minor', 'harassment', 'spam', 'violence', 'other']);

/**
 * Validates a WebRTC signalling payload before relaying it to the peer, so a
 * client can never push arbitrary data to someone else.
 */
export function cleanSignal(data) {
  if (!data || typeof data !== 'object') return null;
  const pairId = typeof data.pairId === 'string' && data.pairId.length <= 64 ? data.pairId : null;
  if (!pairId) return null;

  if (data.kind === 'sdp') {
    const d = data.description;
    if (!d || (d.type !== 'offer' && d.type !== 'answer')) return null;
    if (typeof d.sdp !== 'string' || d.sdp.length > 100_000) return null;
    return { pairId, kind: 'sdp', description: { type: d.type, sdp: d.sdp } };
  }

  if (data.kind === 'ice') {
    const c = data.candidate;
    if (!c || typeof c.candidate !== 'string' || c.candidate.length > 2048) return null;
    const sdpMid = typeof c.sdpMid === 'string' && c.sdpMid.length <= 64 ? c.sdpMid : null;
    const sdpMLineIndex =
      Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 64 ? c.sdpMLineIndex : null;
    if (sdpMid === null && sdpMLineIndex === null) return null;
    const candidate = { candidate: c.candidate, sdpMid, sdpMLineIndex };
    if (typeof c.usernameFragment === 'string' && c.usernameFragment.length <= 256) {
      candidate.usernameFragment = c.usernameFragment;
    }
    return { pairId, kind: 'ice', candidate };
  }

  if (data.kind === 'media') {
    return { pairId, kind: 'media', audio: data.audio !== false, video: data.video !== false };
  }

  return null;
}
