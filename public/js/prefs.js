// Tiny localStorage wrapper. Storage can be unavailable (private mode,
// blocked cookies), so every access is guarded and the app keeps working
// with in-memory defaults.

const KEY = 'hiyo.prefs.v1';
let state = {};
try {
  state = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
} catch {
  state = {};
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — keep in memory */
  }
}

export const prefs = {
  get(key, fallback) {
    return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : fallback;
  },
  set(key, value) {
    state[key] = value;
    save();
  },
};

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Anonymous, random per-browser id. Used only for matching and moderation. */
export function clientId() {
  let id = prefs.get('clientId');
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
    id = uuid();
    prefs.set('clientId', id);
  }
  return id;
}
