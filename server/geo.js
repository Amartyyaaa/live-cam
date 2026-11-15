// Best-effort country detection, used only to show a flag next to strangers.
//
// 1. Geo headers added by CDNs / platforms (free and accurate). Put the app
//    behind Cloudflare and you get CF-IPCountry for every visitor.
// 2. Fallback: the browser's IANA time zone ("Asia/Kolkata" -> IN), mapped
//    with data generated from tzdata (scripts/gen-geo-data.mjs).

import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('./data/geo.json', import.meta.url), 'utf8'));
const COUNTRIES = new Set(data.countries);
const TZ_TO_COUNTRY = new Map(Object.entries(data.tz));

const GEO_HEADERS = [
  'cf-ipcountry', // Cloudflare
  'x-vercel-ip-country', // Vercel
  'cloudfront-viewer-country', // AWS CloudFront
  'x-appengine-country', // Google App Engine
  'fastly-geo-country-code', // Fastly (when configured)
  'x-country-code', // generic / custom proxies
];

export function isCountryCode(code) {
  return typeof code === 'string' && COUNTRIES.has(code);
}

export function countryFromTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length > 64) return null;
  return TZ_TO_COUNTRY.get(tz) ?? null;
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string | undefined} timeZone  value of Intl.DateTimeFormat().resolvedOptions().timeZone
 * @returns {string | null} ISO 3166-1 alpha-2 code
 */
export function detectCountry(headers = {}, timeZone) {
  for (const name of GEO_HEADERS) {
    const raw = headers[name];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
    // "XX" = unknown, "T1" = Tor (Cloudflare) — both fail the lookup below.
    if (isCountryCode(value)) return value;
  }
  return countryFromTimeZone(timeZone);
}
