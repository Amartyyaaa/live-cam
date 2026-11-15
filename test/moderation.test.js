import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore, Moderation } from '../server/moderation.js';

const HOUR = 3_600_000;

function setup(overrides = {}) {
  let t = 1_700_000_000_000;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  const mod = new Moderation({ threshold: 3, windowMs: HOUR, banMs: 24 * HOUR, ipBanMs: HOUR, now, ...overrides });
  return { mod, now };
}

const target = { clientId: 'bad', ipHash: 'bad-ip' };
const reporter = (n) => ({ clientId: `r${n}`, ipHash: `ip${n}` });

test('bans after reports from enough different people', () => {
  const { mod } = setup();
  assert.equal(mod.report({ reporter: reporter(1), target, reason: 'spam' }).banned, false);
  assert.equal(mod.report({ reporter: reporter(2), target, reason: 'spam' }).banned, false);
  const result = mod.report({ reporter: reporter(3), target, reason: 'nudity' });
  assert.equal(result.banned, true);
  assert.ok(mod.isBanned({ clientId: 'bad' }));
  assert.ok(mod.isBanned({ ipHash: 'bad-ip' }), 'IP is banned too');
  assert.ok(mod.isBanned({ clientId: 'fresh-id', ipHash: 'bad-ip' }), 'clearing storage does not evade the IP ban');
});

test('the same reporter (by IP) only counts once', () => {
  const { mod } = setup();
  for (let i = 0; i < 5; i++) {
    mod.report({ reporter: { clientId: `tab${i}`, ipHash: 'same-ip' }, target, reason: 'spam' });
  }
  assert.equal(mod.isBanned(target), null);
});

test('reports outside the time window expire', () => {
  const { mod, now } = setup();
  mod.report({ reporter: reporter(1), target, reason: 'spam' });
  mod.report({ reporter: reporter(2), target, reason: 'spam' });
  now.advance(HOUR + 1);
  assert.equal(mod.report({ reporter: reporter(3), target, reason: 'spam' }).banned, false);
});

test('IP bans are short-lived; browser bans last BAN_HOURS', () => {
  const { mod, now } = setup();
  for (let i = 1; i <= 3; i++) mod.report({ reporter: reporter(i), target, reason: 'spam' });
  now.advance(HOUR + 1);
  assert.equal(mod.isBanned({ clientId: 'someone-else', ipHash: 'bad-ip' }), null, 'shared IP free again after 1h');
  assert.ok(mod.isBanned({ clientId: 'bad' }));
  now.advance(24 * HOUR);
  assert.equal(mod.isBanned({ clientId: 'bad' }), null);
});

test('never bans the IP when the reporter shares it (same Wi-Fi / carrier NAT)', () => {
  const { mod } = setup({ threshold: 1 });
  const result = mod.report({ reporter: { clientId: 'me', ipHash: 'campus' }, target: { clientId: 'them', ipHash: 'campus' }, reason: 'spam' });
  assert.equal(result.banned, true);
  assert.ok(mod.isBanned({ clientId: 'them' }));
  assert.equal(mod.isBanned({ clientId: 'me', ipHash: 'campus' }), null);
});

test('IP-level strikes need twice the threshold', () => {
  const { mod } = setup();
  // Three different browsers behind one IP, each reported once by different people.
  for (let i = 1; i <= 5; i++) {
    const r = mod.report({ reporter: reporter(i), target: { clientId: `user${i}`, ipHash: 'cgnat' }, reason: 'spam' });
    assert.equal(r.banned, false, `report ${i} must not ban yet`);
  }
  assert.equal(mod.report({ reporter: reporter(6), target: { clientId: 'user6', ipHash: 'cgnat' }, reason: 'spam' }).banned, true);
});

test('banIp: false never bans or checks IPs', () => {
  const { mod } = setup({ banIp: false, threshold: 1 });
  mod.report({ reporter: reporter(1), target, reason: 'spam' });
  assert.ok(mod.isBanned({ clientId: 'bad' }));
  assert.equal(mod.isBanned({ clientId: 'other', ipHash: 'bad-ip' }), null);
});

test('manual bans, unban and listings', () => {
  const { mod } = setup();
  mod.ban(['c:abc'], { ms: HOUR, reason: 'manual', source: 'admin' });
  assert.equal(mod.listBans().length, 1);
  assert.equal(mod.unban('c:abc'), true);
  assert.equal(mod.listBans().length, 0);
  mod.report({ reporter: reporter(1), target, reason: 'other', transcript: [{ from: 'reported', text: 'hi', at: 1 }] });
  const [latest] = mod.listReports(10);
  assert.equal(latest.reason, 'other');
  assert.equal(latest.transcript[0].text, 'hi');
});

test('FileStore persists bans across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiyo-mod-'));
  const store = new FileStore(dir, { logger: { warn() {} } });
  const { mod, now } = setup({ store });
  mod.ban(['c:persisted'], { ms: HOUR });
  store.flush();
  const reloaded = new Moderation({ threshold: 3, windowMs: HOUR, banMs: HOUR, store: new FileStore(dir), now });
  assert.ok(reloaded.isBanned({ clientId: 'persisted' }));
  now.advance(HOUR + 1);
  assert.equal(reloaded.isBanned({ clientId: 'persisted' }), null, 'expired bans are dropped');
  fs.rmSync(dir, { recursive: true, force: true });
});
