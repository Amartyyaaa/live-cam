// ICE (STUN/TURN) server configuration handed to browsers.
//
// STUN alone connects most people, but roughly 10–20% of users worldwide sit
// behind symmetric NATs, mobile carrier-grade NAT or strict firewalls and can
// only connect through a TURN relay. Configure one of:
//
//   • TURN_URLS + TURN_SECRET           coturn with use-auth-secret (recommended self-hosted)
//   • TURN_URLS + TURN_USERNAME/CREDENTIAL  any provider with static credentials
//   • CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN   Cloudflare's global anycast TURN

import crypto from 'node:crypto';

/** coturn "TURN REST API" credentials: username = "<expiry>:<id>", password = HMAC-SHA1. */
export function turnRestCredentials(secret, id, ttlSeconds, nowMs = Date.now()) {
  const expiry = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = `${expiry}:${id}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

export class IceProvider {
  /**
   * @param {ReturnType<import('./config.js').loadConfig>['ice']} ice
   * @param {{ fetch?: typeof fetch, now?: () => number, logger?: Pick<Console, 'warn'> }} [deps]
   */
  constructor(ice, { fetch: fetchImpl = globalThis.fetch, now = Date.now, logger = console } = {}) {
    this.ice = ice;
    this.fetch = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.cloudflareCache = null; // { servers, expiresAt }
    this.cloudflarePending = null;
  }

  get usesCloudflare() {
    return Boolean(this.ice.cloudflareKeyId && this.ice.cloudflareApiToken);
  }

  get hasTurn() {
    return this.usesCloudflare || this.ice.turnUrls.length > 0;
  }

  /** @returns {Promise<RTCIceServer[]>} */
  async serversFor(id) {
    const servers = [];
    const { stunUrls, turnUrls, turnSecret, turnUsername, turnCredential, turnTtl } = this.ice;
    if (stunUrls.length) servers.push({ urls: stunUrls });

    if (turnUrls.length) {
      if (turnSecret) {
        servers.push({ urls: turnUrls, ...turnRestCredentials(turnSecret, id, turnTtl, this.now()) });
      } else if (turnUsername && turnCredential) {
        servers.push({ urls: turnUrls, username: turnUsername, credential: turnCredential });
      }
    }

    if (this.usesCloudflare) {
      const cf = await this.#cloudflareServers().catch((err) => {
        this.logger.warn(`[ice] Cloudflare TURN unavailable: ${err.message}`);
        return [];
      });
      servers.push(...cf);
    }
    return servers;
  }

  // Cloudflare credentials are fetched once and shared until close to expiry,
  // so we make at most a handful of API calls per day.
  async #cloudflareServers() {
    const cached = this.cloudflareCache;
    if (cached && cached.expiresAt > this.now()) return cached.servers;
    if (!this.cloudflarePending) {
      this.cloudflarePending = this.#fetchCloudflare().finally(() => {
        this.cloudflarePending = null;
      });
    }
    return this.cloudflarePending;
  }

  async #fetchCloudflare() {
    const { cloudflareKeyId, cloudflareApiToken, turnTtl } = this.ice;
    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cloudflareKeyId)}/credentials/generate-ice-servers`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cloudflareApiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: turnTtl }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const list = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
    const servers = list
      .filter((s) => s && s.urls)
      .map((s) => ({ urls: s.urls, ...(s.username ? { username: s.username, credential: s.credential } : {}) }));
    if (!servers.length) throw new Error('no ICE servers in response');
    // Refresh at half-life so handed-out credentials always have time left.
    this.cloudflareCache = { servers, expiresAt: this.now() + (turnTtl * 1000) / 2 };
    return servers;
  }
}
