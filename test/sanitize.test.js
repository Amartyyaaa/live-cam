import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanInterests, cleanLang, cleanMessage, cleanSignal, containsLink, ipBucket, isUuid } from '../server/sanitize.js';

test('ipBucket groups IPv6 by /64 so bans cannot be dodged by switching address', () => {
  assert.equal(ipBucket('203.0.113.7'), '203.0.113.7');
  assert.equal(ipBucket('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipBucket('2001:db8:85a3:0001:1111:2222:3333:4444'), '2001:db8:85a3:1::/64');
  assert.equal(ipBucket('2001:db8:85a3:1::abcd'), '2001:db8:85a3:1::/64');
  assert.equal(ipBucket('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipBucket('[2001:db8:85a3:1::5]'), '2001:db8:85a3:1::/64');
  assert.equal(ipBucket('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(ipBucket(undefined), 'unknown');
});

test('cleanMessage trims, strips control characters and enforces length', () => {
  assert.equal(cleanMessage('  hello  ').text, 'hello');
  assert.equal(cleanMessage('a\u0000b‮c').text, 'abc');
  assert.equal(cleanMessage('line1\n\n\n\nline2').text, 'line1\n\nline2');
  assert.equal(cleanMessage('x'.repeat(600), { maxLength: 500 }).text.length, 500);
  assert.equal(cleanMessage('   '), null);
  assert.equal(cleanMessage(42), null);
  // Emoji with zero-width joiners survive intact.
  assert.equal(cleanMessage('👨‍👩‍👧 family').text, '👨‍👩‍👧 family');
  // Length is counted in characters, not UTF-16 units.
  assert.equal(Array.from(cleanMessage('😀'.repeat(10), { maxLength: 5 }).text).length, 5);
});

test('link detection catches URLs and bare domains', () => {
  for (const spam of [
    'go to https://evil.example',
    'www.spam.net now',
    'join t.me/channel',
    'bit.ly/abc',
    'my site is example.com',
    'example[.]com',
    'Visit WIN-BIG.xyz!',
  ]) {
    assert.equal(containsLink(spam), true, spam);
  }
});

test('normal chat is not mistaken for links', () => {
  for (const ok of [
    'hello there',
    'I am 20 y.o.',
    'e.g. pizza',
    'version 2.5',
    'I use Node.js',
    'my email is me@gmail',
    'ok...com on',
    'こんにちは。元気？',
    'مرحبا. كيف حالك',
  ]) {
    assert.equal(containsLink(ok), false, ok);
  }
});

test('cleanInterests normalises, de-duplicates and limits tags', () => {
  assert.deepEqual(cleanInterests(['Music', ' music ', '#Anime', 'K-POP']), ['music', 'anime', 'k-pop']);
  assert.deepEqual(cleanInterests(['a', 'b', 'c'], { max: 2 }), ['a', 'b']);
  assert.deepEqual(cleanInterests(['x'.repeat(40)], { maxLength: 24 }), ['x'.repeat(24)]);
  assert.deepEqual(cleanInterests('music'), []);
  assert.deepEqual(cleanInterests([null, 5, '', '  ']), []);
  assert.deepEqual(cleanInterests(['Música', 'ＡＮＩＭＥ']), ['música', 'anime']);
});

test('cleanLang and isUuid', () => {
  assert.equal(cleanLang('pt-BR'), 'pt');
  assert.equal(cleanLang('ZH_hans_CN'), 'zh');
  assert.equal(cleanLang('<script>'), null);
  assert.equal(isUuid('2d7a0c14-4bf1-4a29-b872-87d37a957594'), true);
  assert.equal(isUuid('not-a-uuid'), false);
});

test('cleanSignal only lets well-formed WebRTC messages through', () => {
  const pairId = 'p1';
  assert.deepEqual(cleanSignal({ pairId, kind: 'sdp', description: { type: 'offer', sdp: 'v=0', extra: 1 } }), {
    pairId,
    kind: 'sdp',
    description: { type: 'offer', sdp: 'v=0' },
  });
  assert.equal(cleanSignal({ pairId, kind: 'sdp', description: { type: 'rollback', sdp: '' } }), null);
  assert.deepEqual(cleanSignal({ pairId, kind: 'ice', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } }), {
    pairId,
    kind: 'ice',
    candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
  });
  assert.equal(cleanSignal({ pairId, kind: 'ice', candidate: { candidate: 'x' } }), null);
  assert.deepEqual(cleanSignal({ pairId, kind: 'media', audio: false, video: 'yes' }), { pairId, kind: 'media', audio: false, video: true });
  assert.equal(cleanSignal({ kind: 'media' }), null, 'pairId required');
  assert.equal(cleanSignal({ pairId, kind: 'eval', code: 'x' }), null);
  assert.equal(cleanSignal(null), null);
});
