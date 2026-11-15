#!/usr/bin/env node
// Generates server/data/geo.json from the IANA time zone database that ships
// with most Linux distributions (package "tzdata").
//
//   countries: ISO 3166-1 alpha-2 codes known to tzdata
//   tz:        time zone name (incl. legacy aliases such as Asia/Calcutta) -> country code
//
// The server uses this as a privacy-friendly fallback for showing a stranger's
// country flag when no CDN geo header (e.g. Cloudflare's CF-IPCountry) is present.
//
// Usage: node scripts/gen-geo-data.mjs [/usr/share/zoneinfo]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const zoneinfo = process.argv[2] || '/usr/share/zoneinfo';

const lines = (file) =>
  readFileSync(join(zoneinfo, file), 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'));

const countries = new Set();
for (const line of lines('iso3166.tab')) {
  const [code] = line.split('\t');
  if (/^[A-Z]{2}$/.test(code)) countries.add(code);
}

const tz = {};
for (const line of lines('zone.tab')) {
  const [code, , zone] = line.split('\t');
  if (countries.has(code) && zone) tz[zone] = code;
}

// Legacy aliases ("L <target> <alias>") — browsers still report some of them,
// e.g. Chrome returns "Asia/Calcutta" for India.
for (const line of lines('tzdata.zi')) {
  if (!line.startsWith('L ')) continue;
  const [, target, alias] = line.split(' ');
  if (!tz[alias] && tz[target]) tz[alias] = tz[target];
}

const sorted = Object.fromEntries(Object.entries(tz).sort(([a], [b]) => a.localeCompare(b)));
const out = { countries: [...countries].sort(), tz: sorted };
const file = join(root, 'server', 'data', 'geo.json');
writeFileSync(file, JSON.stringify(out) + '\n');
console.log(`Wrote ${file}: ${out.countries.length} countries, ${Object.keys(sorted).length} time zones`);
