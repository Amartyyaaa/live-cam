// Works out a visitor's real IP the same way for HTTP requests and
// Socket.IO handshakes, then hashes it (raw IPs are never stored).

import crypto from 'node:crypto';
import proxyaddr from 'proxy-addr';
import { ipBucket } from './sanitize.js';

/** Same semantics as Express's "trust proxy" setting. */
export function compileTrust(value) {
  if (typeof value === 'function') return value;
  if (value === true) return () => true;
  if (typeof value === 'number') return (addr, i) => i < value;
  const list = typeof value === 'string' ? value.split(',').map((v) => v.trim()) : value || [];
  return proxyaddr.compile(list);
}

export function createIpTools(config) {
  const trust = compileTrust(config.trustProxy);

  // A header set by your CDN (CLIENT_IP_HEADER, e.g. cf-connecting-ip), else
  // X-Forwarded-For from trusted proxies, else the socket address.
  function clientIp(req) {
    if (config.clientIpHeader) {
      const value = req.headers[config.clientIpHeader];
      const first = (Array.isArray(value) ? value[0] : value)?.split(',')[0].trim();
      if (first) return first;
    }
    try {
      return proxyaddr(req, trust);
    } catch {
      return req.socket?.remoteAddress;
    }
  }

  const hashIp = (ip) =>
    crypto
      .createHmac('sha256', config.secret)
      .update(String(ipBucket(ip) || 'unknown'))
      .digest('base64url')
      .slice(0, 22);

  return { clientIp, ipHashOf: (req) => hashIp(clientIp(req)) };
}
