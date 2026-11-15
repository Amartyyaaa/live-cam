import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleVerifier, readCookie, signSession, verifySession } from '../server/auth.js';
import { GUIDELINES_VERSION, UserStore, hashPassword, normalizeEmail, publicUser, verifyPassword } from '../server/users.js';

test('passwords are hashed with scrypt and verified in constant time', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.notEqual(await hashPassword('same'), await hashPassword('same'), 'salted');
});

test('session tokens: valid, tampered, expired, wrong secret', () => {
  const now = Date.now();
  const token = signSession({ uid: 'u1', exp: Math.floor(now / 1000) + 60 }, 'secret');
  assert.equal(verifySession(token, 'secret', now).uid, 'u1');
  assert.equal(verifySession(token, 'other-secret', now), null);
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 'admin', exp: 9e9 })).toString('base64url');
  assert.equal(verifySession(`${forged}.${mac}`, 'secret', now), null);
  assert.equal(verifySession(`${body}.${mac}x`, 'secret', now), null);
  assert.equal(verifySession(token, 'secret', now + 61_000), null, 'expired');
  assert.equal(verifySession('nonsense', 'secret'), null);
});

test('readCookie', () => {
  assert.equal(readCookie('a=1; hiyo_session=abc.def; b=2', 'hiyo_session'), 'abc.def');
  assert.equal(readCookie('a=1', 'hiyo_session'), null);
  assert.equal(readCookie(undefined, 'x'), null);
  assert.equal(readCookie('lang=pt%2DBR', 'lang'), 'pt-BR');
});

// --- Google: sign our own tokens with a local RSA key and serve it as JWKS.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

function googleToken(claims, { kid = 'test-key', key = privateKey } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

function verifier(overrides = {}) {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return { ok: true, headers: { get: () => 'public, max-age=3600' }, json: async () => ({ keys: [jwk] }) };
  };
  const v = new GoogleVerifier({ clientId: 'my-client.apps.googleusercontent.com', fetch, ...overrides });
  return { v, calls: () => calls };
}

const claims = (extra = {}) => ({
  iss: 'https://accounts.google.com',
  aud: 'my-client.apps.googleusercontent.com',
  sub: '1234567890',
  email: 'ana@example.com',
  email_verified: true,
  name: 'Ana',
  picture: 'https://lh3.googleusercontent.com/a/photo',
  exp: Math.floor(Date.now() / 1000) + 600,
  ...extra,
});

test('Google ID tokens are verified with Google\'s keys', async () => {
  const { v, calls } = verifier();
  const identity = await v.verify(googleToken(claims()));
  assert.deepEqual(identity, {
    sub: '1234567890',
    email: 'ana@example.com',
    name: 'Ana',
    picture: 'https://lh3.googleusercontent.com/a/photo',
  });
  await v.verify(googleToken(claims()));
  assert.equal(calls(), 1, 'keys are cached');
});

test('Google tokens for another app, expired, forged or unverified are refused', async () => {
  const { v } = verifier();
  await assert.rejects(v.verify(googleToken(claims({ aud: 'someone-else' }))), { code: 'google' });
  await assert.rejects(v.verify(googleToken(claims({ iss: 'https://evil.example' }))), { code: 'google' });
  await assert.rejects(v.verify(googleToken(claims({ exp: Math.floor(Date.now() / 1000) - 3600 }))), { code: 'google' });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(v.verify(googleToken(claims(), { key: other })), { code: 'google' });
  await assert.rejects(v.verify('not.a.token'), { code: 'google' });
  const unverified = await v.verify(googleToken(claims({ email_verified: false })));
  assert.equal(unverified.email, null, 'unverified emails are never trusted');
  await assert.rejects(new GoogleVerifier({ clientId: '' }).verify('a.b.c'), { code: 'google_disabled' });
});

test('UserStore: sign-up, duplicates, login, Google linking, guidelines, persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiyo-users-'));
  const file = path.join(dir, 'users.json');
  const users = new UserStore({ file });

  const user = await users.createWithPassword({ name: '  Ana  ', email: ' Ana@Example.COM ', password: 'longenough' });
  assert.equal(user.email, 'ana@example.com');
  assert.equal(user.name, 'Ana');
  await assert.rejects(users.createWithPassword({ name: 'X', email: 'ana@example.com', password: 'longenough' }), { code: 'exists' });
  await assert.rejects(users.createWithPassword({ name: 'X', email: 'bad', password: 'longenough' }), { code: 'email' });
  await assert.rejects(users.createWithPassword({ name: 'X', email: 'x@y.co', password: 'short' }), { code: 'weak' });
  await assert.rejects(users.createWithPassword({ name: ' ', email: 'x@y.co', password: 'longenough' }), { code: 'name' });
  const ben = await users.createWithPassword({ name: 'Ben', email: 'ben@example.com', password: 'bens-password' });

  assert.equal((await users.checkPassword('ANA@example.com', 'longenough'))?.id, user.id);
  assert.equal(await users.checkPassword('ana@example.com', 'nope'), null);
  assert.equal(await users.checkPassword('nobody@example.com', 'longenough'), null);

  // Google sign-in with the same verified email links to the same account…
  const linked = users.upsertGoogle({ sub: 'g-1', email: 'ana@example.com', name: 'A', picture: 'https://lh3.googleusercontent.com/x' });
  assert.equal(linked.id, user.id);
  assert.equal(linked.picture, 'https://lh3.googleusercontent.com/x');
  // …and the unverified password stops working (it may have been set by someone squatting the address).
  assert.equal(await users.checkPassword('ana@example.com', 'longenough'), null);
  assert.equal(users.upsertGoogle({ sub: 'g-1', email: 'ana@example.com', name: 'A' }).id, user.id);
  const fresh = users.upsertGoogle({ sub: 'g-2', email: null, name: 'New Person', picture: 'https://evil.example/x.png' });
  assert.notEqual(fresh.id, user.id);
  assert.equal(fresh.picture, null, 'only Google-hosted pictures');
  assert.equal(users.upsertGoogle({ sub: 'g-2', email: null, name: 'Renamed' }).id, fresh.id);

  assert.equal(publicUser(user).guidelinesAccepted, false);
  users.acceptGuidelines(user.id);
  assert.equal(publicUser(user).guidelinesAccepted, true);
  assert.equal(user.guidelinesVersion, GUIDELINES_VERSION);
  assert.equal('passwordHash' in publicUser(ben), false);
  assert.equal(users.list(10).some((u) => 'passwordHash' in u), false);

  users.flush();
  const reloaded = new UserStore({ file });
  assert.equal(reloaded.size, 3);
  assert.equal((await reloaded.checkPassword('ben@example.com', 'bens-password'))?.id, ben.id);
  assert.equal(reloaded.upsertGoogle({ sub: 'g-1', email: 'ana@example.com', name: 'A' }).id, user.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizeEmail', () => {
  assert.equal(normalizeEmail(' A@B.Co '), 'a@b.co');
  assert.equal(normalizeEmail('no-at-sign'), null);
  assert.equal(normalizeEmail('a@b'), null);
  assert.equal(normalizeEmail(42), null);
});
