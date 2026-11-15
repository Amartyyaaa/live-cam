// Small token-bucket rate limiters (no dependencies, O(1) per call).

export class TokenBucket {
  /**
   * @param {{ capacity: number, refillPerSec: number, now?: () => number }} opts
   */
  constructor({ capacity, refillPerSec, now = Date.now }) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSec / 1000;
    this.now = now;
    this.tokens = capacity;
    this.updatedAt = now();
  }

  #refill() {
    const t = this.now();
    const elapsed = t - this.updatedAt;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.updatedAt = t;
    }
  }

  take(n = 1) {
    this.#refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  get full() {
    this.#refill();
    return this.tokens >= this.capacity;
  }
}

/** One bucket per key (e.g. per hashed IP), with periodic cleanup of idle keys. */
export class KeyedLimiter {
  constructor({ capacity, refillPerSec, now = Date.now, maxKeys = 100_000 }) {
    this.opts = { capacity, refillPerSec, now };
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  take(key, n = 1) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.sweep();
      bucket = new TokenBucket(this.opts);
      this.buckets.set(key, bucket);
    }
    return bucket.take(n);
  }

  /** Drop buckets that have refilled completely — they carry no state. */
  sweep() {
    for (const [key, bucket] of this.buckets) {
      if (bucket.full) this.buckets.delete(key);
    }
  }
}
