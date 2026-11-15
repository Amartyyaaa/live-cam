import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { IceProvider, turnRestCredentials } from '../server/ice.js';
import { countryFromTimeZone, detectCountry } from '../server/geo.js';
import { loadConfig } from '../server/config.js';

const ice = (env) => loadConfig(env).ice;

test('STUN-only by default', async () => {
  const servers = await new IceProvider(ice({})).serversFor('id');
  assert.equal(servers.length, 1);
  assert.ok(servers[0].urls.every((u) => u.startsWith('stun:')));
});

test('coturn REST credentials (use-auth-secret)', async () => {
  const now = 1_700_000_000_000;
  const { username, credential } = turnRestCredentials('s3cret', 'abc', 3600, now);
  assert.equal(username, `${now / 1000 + 3600}:abc`);
  assert.equal(credential, crypto.createHmac('sha1', 's3cret').update(username).digest('base64'));

  const provider = new IceProvider(ice({ TURN_URLS: 'turn:turn.example.com:3478,turns:turn.example.com:5349', TURN_SECRET: 'x' }));
  const servers = await provider.serversFor('abc');
  const turn = servers.find((s) => s.urls.some((u) => u.startsWith('turn')));
  assert.deepEqual(turn.urls, ['turn:turn.example.com:3478', 'turns:turn.example.com:5349']);
  assert.match(turn.username, /^\d+:abc$/);
});

test('static TURN credentials', async () => {
  const servers = await new IceProvider(ice({ TURN_URLS: 'turn:t.example', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' })).serversFor('x');
  assert.deepEqual(servers[1], { urls: ['turn:t.example'], username: 'u', credential: 'p' });
});

test('Cloudflare TURN credentials are fetched once and cached', async () => {
  let calls = 0;
  const fetch = async (url, init) => {
    calls++;
    assert.match(url, /rtc\.live\.cloudflare\.com\/v1\/turn\/keys\/key123\/credentials/);
    assert.equal(init.headers.Authorization, 'Bearer tok');
    return {
      ok: true,
      json: async () => ({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'cf', credential: 'pw' }] }),
    };
  };
  const provider = new IceProvider(ice({ CLOUDFLARE_TURN_KEY_ID: 'key123', CLOUDFLARE_TURN_API_TOKEN: 'tok' }), { fetch });
  const [a, b] = await Promise.all([provider.serversFor('1'), provider.serversFor('2')]);
  await provider.serversFor('3');
  assert.equal(calls, 1);
  assert.equal(a.at(-1).username, 'cf');
  assert.deepEqual(a, b);
});

test('Cloudflare outage degrades to STUN instead of failing', async () => {
  const provider = new IceProvider(ice({ CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_API_TOKEN: 't' }), {
    fetch: async () => ({ ok: false, status: 503 }),
    logger: { warn() {} },
  });
  const servers = await provider.serversFor('x');
  assert.equal(servers.length, 1);
});

test('country detection: CDN headers first, then time zone', () => {
  assert.equal(detectCountry({ 'cf-ipcountry': 'br' }, 'Asia/Kolkata'), 'BR');
  assert.equal(detectCountry({ 'cf-ipcountry': 'XX' }, 'Asia/Kolkata'), 'IN', 'XX = unknown');
  assert.equal(detectCountry({ 'cf-ipcountry': 'T1' }), null, 'Tor exit');
  assert.equal(detectCountry({ 'x-vercel-ip-country': 'JP' }), 'JP');
  assert.equal(detectCountry({}, 'Asia/Calcutta'), 'IN', 'legacy alias still used by Chrome');
  assert.equal(detectCountry({}, 'America/Sao_Paulo'), 'BR');
  assert.equal(detectCountry({}, 'Etc/UTC'), null);
  assert.equal(countryFromTimeZone('../../etc/passwd'), null);
});

test('config parsing', () => {
  const c = loadConfig({ PORT: '8080', BLOCK_LINKS: 'false', TRUST_PROXY: '1', BAN_HOURS: '48', APP_NAME: 'Kismet' });
  assert.equal(c.port, 8080);
  assert.equal(c.moderation.blockLinks, false);
  assert.equal(c.trustProxy, 1);
  assert.equal(c.moderation.banMs, 48 * 3_600_000);
  assert.equal(c.appName, 'Kismet');
  assert.equal(loadConfig({}).trustProxy, 'loopback, linklocal, uniquelocal');
  assert.equal(loadConfig({ PORT: 'abc' }).port, 3000);
});
