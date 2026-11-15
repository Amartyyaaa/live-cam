// Matchmaking queue for 1-on-1 random chats.
//
// Rules, in order:
//   1. Same mode only (video ↔ video, text ↔ text).
//   2. Never pair two tabs of the same device, people who recently met, or
//      someone a user reported (the `avoid` sets).
//   3. "Same language only" is honoured in both directions.
//   4. People with interests first get matched with whoever shares the most
//      of them. After `interestWaitMs` without luck they become open to a
//      random stranger — the classic Omegle behaviour.
//   5. Otherwise first come, first served.
//
// The class is pure (no sockets, injectable clock) so it is easy to test and
// could later be backed by Redis for multi-server deployments.

/**
 * @typedef {object} Candidate
 * @property {string} id         unique per connection (socket id)
 * @property {string[]} keys     identity keys, keys[0] = device key ("c:<clientId>")
 * @property {'video'|'text'} mode
 * @property {string[]} interests  normalised tags
 * @property {string|null} lang  e.g. "es"
 * @property {boolean} langOnly  only match people with the same `lang`
 * @property {Set<string>} avoid keys this user must not be matched with
 */

/** @typedef {Candidate & { joinedAt: number }} Entry */

export function sharedInterests(a, b) {
  if (!a.interests.length || !b.interests.length) return [];
  const set = new Set(b.interests);
  return a.interests.filter((tag) => set.has(tag));
}

/** @param {Entry} x @param {Entry} y */
export function compatible(x, y) {
  if (x.id === y.id) return false;
  if (x.mode !== y.mode) return false;
  if (x.keys[0] && x.keys[0] === y.keys[0]) return false;
  for (const key of y.keys) if (x.avoid?.has(key)) return false;
  for (const key of x.keys) if (y.avoid?.has(key)) return false;
  if (x.langOnly && x.lang !== y.lang) return false;
  if (y.langOnly && y.lang !== x.lang) return false;
  return true;
}

export class Matchmaker {
  /** @param {{ interestWaitMs?: number, now?: () => number }} [opts] */
  constructor({ interestWaitMs = 5000, now = Date.now } = {}) {
    this.interestWaitMs = interestWaitMs;
    this.now = now;
    /** @type {Map<string, Entry>} insertion order = waiting order */
    this.waiting = new Map();
    /** @type {Map<string, Set<string>>} tag -> waiting ids */
    this.byInterest = new Map();
  }

  get size() {
    return this.waiting.size;
  }

  has(id) {
    return this.waiting.has(id);
  }

  countByMode() {
    const counts = { video: 0, text: 0 };
    for (const entry of this.waiting.values()) counts[entry.mode] = (counts[entry.mode] || 0) + 1;
    return counts;
  }

  /**
   * Adds a user to the queue, or pairs them immediately.
   * @param {Candidate} candidate
   * @returns {{ a: Entry, b: Entry, shared: string[] } | null}  `a` waited longer
   */
  enqueue(candidate) {
    this.remove(candidate.id);
    /** @type {Entry} */
    const entry = { ...candidate, interests: [...new Set(candidate.interests || [])], joinedAt: this.now() };
    const partner = this.#bestInterestMatch(entry) ?? (this.#openToRandom(entry) ? this.#firstRandom(entry) : null);
    if (partner) {
      this.remove(partner.id);
      return { a: partner, b: entry, shared: sharedInterests(partner, entry) };
    }
    this.#add(entry);
    return null;
  }

  remove(id) {
    const entry = this.waiting.get(id);
    if (!entry) return false;
    this.waiting.delete(id);
    for (const tag of entry.interests) {
      const ids = this.byInterest.get(tag);
      if (!ids) continue;
      ids.delete(id);
      if (!ids.size) this.byInterest.delete(tag);
    }
    return true;
  }

  /**
   * Periodic pass that pairs people whose interest-only window just expired.
   * @returns {Array<{ a: Entry, b: Entry, shared: string[] }>}
   */
  tick() {
    const matches = [];
    for (const entry of [...this.waiting.values()]) {
      if (!entry.interests.length || !this.waiting.has(entry.id)) continue;
      if (!this.#openToRandom(entry)) continue;
      const partner = this.#firstRandom(entry);
      if (!partner) continue;
      this.remove(entry.id);
      this.remove(partner.id);
      const [a, b] = entry.joinedAt <= partner.joinedAt ? [entry, partner] : [partner, entry];
      matches.push({ a, b, shared: sharedInterests(a, b) });
    }
    return matches;
  }

  #add(entry) {
    this.waiting.set(entry.id, entry);
    for (const tag of entry.interests) {
      let ids = this.byInterest.get(tag);
      if (!ids) this.byInterest.set(tag, (ids = new Set()));
      ids.add(entry.id);
    }
  }

  #openToRandom(entry) {
    return entry.interests.length === 0 || this.now() - entry.joinedAt >= this.interestWaitMs;
  }

  #bestInterestMatch(entry) {
    if (!entry.interests.length) return null;
    const scores = new Map();
    for (const tag of entry.interests) {
      const ids = this.byInterest.get(tag);
      if (!ids) continue;
      for (const id of ids) scores.set(id, (scores.get(id) || 0) + 1);
    }
    let best = null;
    let bestScore = 0;
    for (const [id, score] of scores) {
      const other = this.waiting.get(id);
      if (!other || !compatible(entry, other)) continue;
      if (score > bestScore || (score === bestScore && other.joinedAt < best.joinedAt)) {
        best = other;
        bestScore = score;
      }
    }
    return best;
  }

  #firstRandom(entry) {
    for (const other of this.waiting.values()) {
      if (other.id !== entry.id && this.#openToRandom(other) && compatible(entry, other)) return other;
    }
    return null;
  }
}
