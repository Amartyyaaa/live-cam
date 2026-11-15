import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matchmaker, compatible, sharedInterests } from '../server/matchmaker.js';

let seq = 0;
function user(overrides = {}) {
  const id = overrides.id ?? `u${++seq}`;
  return {
    id,
    keys: [`c:${id}`, `i:${overrides.ip ?? id}`],
    mode: 'video',
    interests: [],
    lang: 'en',
    langOnly: false,
    avoid: new Set(),
    ...overrides,
  };
}

function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

test('pairs two random strangers immediately, oldest first', () => {
  const mm = new Matchmaker();
  const a = user();
  assert.equal(mm.enqueue(a), null);
  const match = mm.enqueue(user());
  assert.equal(match.a.id, a.id);
  assert.equal(mm.size, 0);
});

test('never mixes video and text users', () => {
  const mm = new Matchmaker();
  mm.enqueue(user({ mode: 'video' }));
  assert.equal(mm.enqueue(user({ mode: 'text' })), null);
  assert.deepEqual(mm.countByMode(), { video: 1, text: 1 });
});

test('prefers the stranger with the most shared interests', () => {
  const mm = new Matchmaker({ interestWaitMs: 0 });
  mm.enqueue(user({ id: 'random' }));
  mm.enqueue(user({ id: 'one', interests: ['music', 'art'] }));
  mm.enqueue(user({ id: 'two', interests: ['music', 'travel', 'anime'] }));
  const match = mm.enqueue(user({ interests: ['music', 'travel'] }));
  assert.equal(match.a.id, 'two');
  assert.deepEqual(match.shared, ['music', 'travel']);
});

test('people with interests wait for a shared match before going random', () => {
  const now = clock();
  const mm = new Matchmaker({ interestWaitMs: 5000, now });
  mm.enqueue(user({ id: 'gamer', interests: ['gaming'] }));
  assert.equal(mm.enqueue(user({ id: 'plain' })), null, 'not matched while the interest window is open');
  now.advance(4999);
  assert.deepEqual(mm.tick(), []);
  now.advance(1);
  const [match] = mm.tick();
  assert.deepEqual([match.a.id, match.b.id], ['gamer', 'plain']);
  assert.equal(mm.size, 0);
});

test('a later shared-interest arrival wins over waiting it out', () => {
  const now = clock();
  const mm = new Matchmaker({ interestWaitMs: 5000, now });
  mm.enqueue(user({ id: 'a', interests: ['anime'] }));
  now.advance(1000);
  const match = mm.enqueue(user({ id: 'b', interests: ['Anime'.toLowerCase()] }));
  assert.equal(match.a.id, 'a');
  assert.deepEqual(match.shared, ['anime']);
});

test('"same language only" is honoured in both directions', () => {
  const mm = new Matchmaker();
  mm.enqueue(user({ id: 'es', lang: 'es', langOnly: true }));
  assert.equal(mm.enqueue(user({ lang: 'en' })), null);
  const match = mm.enqueue(user({ lang: 'es' }));
  assert.equal(match.a.id, 'es');

  const mm2 = new Matchmaker();
  mm2.enqueue(user({ id: 'open', lang: 'en' }));
  assert.equal(mm2.enqueue(user({ lang: 'pt', langOnly: true })), null);
});

test('recently met and reported people are never paired again', () => {
  const mm = new Matchmaker();
  const a = user({ id: 'a' });
  a.avoid.add('c:b');
  mm.enqueue(a);
  assert.equal(mm.enqueue(user({ id: 'b' })), null);
  // Avoidance is symmetric and also works on the IP key.
  const mm2 = new Matchmaker();
  mm2.enqueue(user({ id: 'x', ip: 'shared' }));
  const y = user({ id: 'y' });
  y.avoid.add('i:shared');
  assert.equal(mm2.enqueue(y), null);
});

test('two tabs of the same browser are never matched together', () => {
  const mm = new Matchmaker();
  mm.enqueue(user({ id: 'tab1', keys: ['c:same', 'i:1'] }));
  assert.equal(mm.enqueue(user({ id: 'tab2', keys: ['c:same', 'i:1'] })), null);
});

test('remove() takes people out of the queue and the interest index', () => {
  const mm = new Matchmaker();
  mm.enqueue(user({ id: 'a', interests: ['music'] }));
  assert.equal(mm.remove('a'), true);
  assert.equal(mm.remove('a'), false);
  assert.equal(mm.byInterest.size, 0);
  assert.equal(mm.enqueue(user({ interests: ['music'] })), null);
});

test('re-enqueueing the same id replaces the old entry', () => {
  const mm = new Matchmaker();
  mm.enqueue(user({ id: 'a', mode: 'text' }));
  mm.enqueue(user({ id: 'a', mode: 'video' }));
  assert.equal(mm.size, 1);
  assert.deepEqual(mm.countByMode(), { video: 1, text: 0 });
});

test('helpers', () => {
  assert.deepEqual(sharedInterests({ interests: ['a', 'b'] }, { interests: ['b', 'c'] }), ['b']);
  assert.deepEqual(sharedInterests({ interests: [] }, { interests: ['b'] }), []);
  assert.equal(compatible(user({ id: 'z' }), user({ id: 'z' })), false);
});
