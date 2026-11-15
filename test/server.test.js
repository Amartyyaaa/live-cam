// Integration tests: real HTTP server + real Socket.IO clients.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { io as connect } from 'socket.io-client';
import { createServer } from '../server/app.js';
import { loadConfig } from '../server/config.js';

const quiet = { ...console, info() {}, warn() {}, error() {} };
let server;
let base;
const sockets = [];

before(async () => {
  const config = loadConfig({
    INTEREST_WAIT_MS: '300',
    REPORT_THRESHOLD: '1',
    ADMIN_TOKEN: 'admin-secret',
    CONNECTIONS_PER_MINUTE: '1000',
  });
  server = createServer(config, { logger: quiet, store: null });
  const { port } = await server.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  for (const s of sockets) s.disconnect();
  await server.close();
});

function client({ clientId = crypto.randomUUID(), tz = 'Europe/Berlin', lang = 'en' } = {}) {
  const socket = connect(base, { auth: { clientId, tz, lang }, transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(socket);
  socket.clientId = clientId;
  return socket;
}

const once = (socket, event, ms = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), ms);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });

const nothing = (socket, event, ms = 300) =>
  new Promise((resolve, reject) => {
    const handler = (data) => reject(new Error(`unexpected "${event}": ${JSON.stringify(data)}`));
    socket.once(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, ms);
  });

async function ready(opts) {
  const socket = client(opts);
  socket.hello = await once(socket, 'hello');
  return socket;
}

async function pair(mode = 'video', a, b) {
  a ??= await ready();
  b ??= await ready();
  const [ma, mb] = await Promise.all([
    once(a, 'matched'),
    once(b, 'matched'),
    a.emitWithAck('find', { mode, interests: [] }),
    b.emitWithAck('find', { mode, interests: [] }),
  ]);
  return { a, b, ma, mb };
}

describe('realtime', () => {
  test('hello carries ICE servers, country and the online count', async () => {
    const s = await ready({ tz: 'Asia/Tokyo' });
    assert.ok(Array.isArray(s.hello.iceServers) && s.hello.iceServers.length > 0);
    assert.equal(s.hello.country, 'JP');
    assert.ok(s.hello.online >= 1);
    assert.equal(s.hello.iceTransportPolicy, 'all');
  });

  test('two people are matched with complementary roles and see each other\'s country', async () => {
    const a = await ready({ tz: 'America/Mexico_City' });
    const b = await ready({ tz: 'Africa/Nairobi' });
    const { ma, mb } = await pair('video', a, b);
    assert.equal(ma.pairId, mb.pairId);
    assert.notEqual(ma.initiator, mb.initiator);
    assert.equal(ma.partner.country, 'KE');
    assert.equal(mb.partner.country, 'MX');
  });

  test('signals are relayed only within the current pair', async () => {
    const { a, b, ma } = await pair();
    const description = { type: 'offer', sdp: 'v=0\r\n' };
    const got = once(b, 'signal');
    a.emit('signal', { pairId: ma.pairId, kind: 'sdp', description });
    assert.deepEqual(await got, { pairId: ma.pairId, kind: 'sdp', description });

    const silence = nothing(b, 'signal');
    a.emit('signal', { pairId: 'someone-else', kind: 'sdp', description });
    a.emit('signal', { pairId: ma.pairId, kind: 'hack', payload: 1 });
    await silence;
  });

  test('messages are cleaned, relayed and acknowledged; links are refused', async () => {
    const { a, b, ma } = await pair('text');
    const got = once(b, 'message');
    const ack = await a.emitWithAck('message', { pairId: ma.pairId, text: '  hola\u0000 ' });
    assert.deepEqual([ack.ok, ack.text], [true, 'hola']);
    assert.equal((await got).text, 'hola');

    const silence = nothing(b, 'message');
    const refused = await a.emitWithAck('message', { pairId: ma.pairId, text: 'free stuff at spam.xyz' });
    assert.deepEqual(refused, { ok: false, error: 'links_blocked' });
    assert.deepEqual(await a.emitWithAck('message', { pairId: 'nope', text: 'hi' }), { ok: false, error: 'not_paired' });
    await silence;
  });

  test('typing indicators are relayed', async () => {
    const { a, b, ma } = await pair('text');
    const got = once(b, 'typing');
    a.emit('typing', { pairId: ma.pairId, on: true });
    assert.deepEqual(await got, { pairId: ma.pairId, on: true });
  });

  test('"find" while chatting skips: the partner is told, and they are not re-matched', async () => {
    const { a, b, ma } = await pair('text');
    const left = once(b, 'partner_left');
    await a.emitWithAck('find', { mode: 'text', interests: [] });
    assert.deepEqual(await left, { pairId: ma.pairId, reason: 'skipped' });
    const silence = Promise.all([nothing(a, 'matched', 600), nothing(b, 'matched', 600)]);
    await b.emitWithAck('find', { mode: 'text', interests: [] });
    await silence;
    a.emit('stop');
    b.emit('stop');
  });

  test('closing the tab notifies the partner', async () => {
    const { a, b, ma } = await pair();
    const left = once(b, 'partner_left');
    a.disconnect();
    assert.deepEqual(await left, { pairId: ma.pairId, reason: 'disconnected' });
  });

  test('a report ends the chat, bans the offender and blocks reconnection', async () => {
    const { a, b, ma } = await pair('text');
    const banned = once(b, 'banned');
    const ack = await a.emitWithAck('report', { pairId: ma.pairId, reason: 'harassment' });
    assert.deepEqual(ack, { ok: true });
    assert.ok((await banned).until > Date.now());

    const again = client({ clientId: b.clientId });
    const err = await once(again, 'connect_error');
    assert.equal(err.data.code, 'banned');

    // The reporter shares the test machine's IP and must NOT be affected.
    assert.equal(a.connected, true);
    const fresh = await ready();
    assert.ok(fresh.connected);

    const [report] = server.moderation.listReports(1);
    assert.equal(report.reason, 'harassment');
  });

  test('the last partner can still be reported right after they skip', async () => {
    const { a, b, ma } = await pair('text');
    await b.emitWithAck('message', { pairId: ma.pairId, text: 'something rude' });
    await a.emitWithAck('find', { mode: 'text', interests: [] }); // a skips first
    const ack = await a.emitWithAck('report', { pairId: ma.pairId, reason: 'spam' });
    assert.deepEqual(ack, { ok: true });
    const [report] = server.moderation.listReports(1);
    assert.equal(report.transcript.at(-1).text, 'something rude');
    assert.equal(report.transcript.at(-1).from, 'reported');
    a.emit('stop');
  });

  test('garbage input is ignored without crashing the server', async () => {
    const s = await ready();
    for (const event of ['find', 'signal', 'message', 'typing', 'report', 'stop']) {
      s.emit(event, null);
      s.emit(event, 'x'.repeat(1000));
      s.emit(event, { pairId: { $ne: 1 }, mode: ['video'], interests: 'music', text: {} });
    }
    assert.deepEqual(await s.emitWithAck('find', { mode: 'audio' }), { ok: false, error: 'invalid' });
    assert.deepEqual(await s.emitWithAck('report', { reason: 'because' }), { ok: false, error: 'invalid' });
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  });

  test('CLIENT_IP_HEADER: the CDN-provided IP is used for bans', async () => {
    const config = loadConfig({ CLIENT_IP_HEADER: 'cf-connecting-ip', REPORT_THRESHOLD: '1' });
    const cdn = createServer(config, { logger: quiet, store: null });
    const { port } = await cdn.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${port}`;
    const make = (ip) =>
      connect(url, {
        auth: { clientId: crypto.randomUUID() },
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        extraHeaders: { 'cf-connecting-ip': ip },
      });
    try {
      const a = make('198.51.100.1');
      const b = make('198.51.100.2');
      await Promise.all([once(a, 'hello'), once(b, 'hello')]);
      const [ma] = await Promise.all([once(a, 'matched'), once(b, 'matched'), a.emitWithAck('find', { mode: 'text' }), b.emitWithAck('find', { mode: 'text' })]);
      await a.emitWithAck('report', { pairId: ma.pairId, reason: 'spam' });
      // b's IP (198.51.100.2) is banned for new browsers; a's IP is not.
      const sameIp = make('198.51.100.2');
      assert.equal((await once(sameIp, 'connect_error')).data.code, 'banned');
      const other = make('198.51.100.3');
      await once(other, 'hello');
      for (const s of [a, b, sameIp, other]) s.disconnect();
    } finally {
      await cdn.close();
    }
  });

  test('rapid skipping is rate limited', async () => {
    const s = await ready();
    const results = [];
    for (let i = 0; i < 15; i++) results.push(await s.emitWithAck('find', { mode: 'video', interests: [] }));
    assert.ok(results.some((r) => r.error === 'rate_limited'));
    s.emit('stop');
  });
});

describe('http', () => {
  test('pages are server-rendered per language with hreflang alternates', async () => {
    const res = await fetch(`${base}/es`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<html lang="es" dir="ltr">/);
    assert.match(html, /Saluda al <em>mundo<\/em>/);
    assert.match(html, /hreflang="ar" href="[^"]+\/ar"/);
    assert.match(html, /hreflang="x-default"/);
    const ar = await (await fetch(`${base}/ar`)).text();
    assert.match(ar, /<html lang="ar" dir="rtl">/);
  });

  test('"/" redirects to the browser language unless a language was chosen', async () => {
    const redirect = await fetch(`${base}/`, { headers: { 'accept-language': 'pt-BR,pt;q=0.9' }, redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/pt');
    const chosen = await fetch(`${base}/`, { headers: { 'accept-language': 'pt-BR', cookie: 'lang=en' }, redirect: 'manual' });
    assert.equal(chosen.status, 200);
    const english = await fetch(`${base}/`, { headers: { 'accept-language': 'en-GB' }, redirect: 'manual' });
    assert.equal(english.status, 200);
  });

  test('security headers protect the camera page', async () => {
    const res = await fetch(`${base}/`);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('permissions-policy'), /camera=\(self\)/);
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('legal pages, manifest, sitemap and 404', async () => {
    for (const path of ['/terms', '/privacy', '/guidelines']) {
      assert.equal((await fetch(base + path)).status, 200, path);
    }
    const manifest = await (await fetch(`${base}/manifest.webmanifest?lang=hi`)).json();
    assert.equal(manifest.lang, 'hi');
    assert.equal(manifest.start_url, '/hi');
    const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
    assert.match(sitemap, /<loc>[^<]+\/ja<\/loc>/);
    assert.equal((await fetch(`${base}/does-not-exist`)).status, 404);
  });

  test('admin API requires the token', async () => {
    assert.equal((await fetch(`${base}/api/admin/reports`)).status, 401);
    assert.equal((await fetch(`${base}/api/admin/reports`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const auth = { authorization: 'Bearer admin-secret', 'content-type': 'application/json' };
    const reports = await (await fetch(`${base}/api/admin/reports`, { headers: auth })).json();
    assert.ok(Array.isArray(reports.reports));

    const victim = await ready();
    const kicked = once(victim, 'banned');
    const res = await fetch(`${base}/api/admin/bans`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ key: `c:${victim.clientId}`, hours: 2, reason: 'test' }),
    });
    assert.equal(res.status, 200);
    await kicked;
    const bans = await (await fetch(`${base}/api/admin/bans`, { headers: auth })).json();
    assert.ok(bans.bans.some((b) => b.key === `c:${victim.clientId}` && b.source === 'admin'));
    const removed = await (await fetch(`${base}/api/admin/bans/c:${victim.clientId}`, { method: 'DELETE', headers: auth })).json();
    assert.equal(removed.ok, true);
  });
});
