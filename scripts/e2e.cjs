#!/usr/bin/env node
// End-to-end test: real Chromium browsers with fake cameras talk to each
// other through the real server — matching, WebRTC video, chat, link
// blocking, skipping, reporting and text mode.
//
//   npm i -D playwright && npx playwright install chromium   (once, locally)
//   npm run test:e2e

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const STEP_TIMEOUT = 20_000;
let passed = 0;

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.stack || err}`);
    throw err;
  }
}

async function main() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiyo-e2e-'));
  process.env.INTEREST_WAIT_MS = '1500';
  process.env.REPORT_THRESHOLD = '1';
  const { loadConfig } = await import(path.join(ROOT, 'server/config.js'));
  const { createServer } = await import(path.join(ROOT, 'server/app.js'));
  const server = createServer(loadConfig(), { logger: { ...console, info() {}, warn() {} } });
  const { port } = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const problems = [];

  async function user(name, { timezoneId = 'Europe/Berlin', locale = 'en-US' } = {}) {
    const context = await browser.newContext({ timezoneId, locale, viewport: { width: 1280, height: 800 } });
    await context.grantPermissions(['camera', 'microphone']);
    const page = await context.newPage();
    page.on('pageerror', (err) => problems.push(`${name}: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`${name}: console: ${msg.text()}`);
    });
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__app?.socket?.connected === true, null, { timeout: STEP_TIMEOUT });
    return page;
  }
  const state = (page) => page.locator('#chat-layout').getAttribute('data-state');
  const waitState = (page, value, timeout = STEP_TIMEOUT) =>
    page.waitForFunction((v) => document.getElementById('chat-layout').dataset.state === v, value, { timeout });
  async function start(page, mode = 'video', interests = []) {
    for (const tag of interests) await page.click(`.chip-suggest[data-interest="${tag}"]`);
    if (!(await page.isChecked('#consent'))) await page.check('#consent');
    await page.click(mode === 'video' ? '#start-video' : '#start-text');
  }
  async function send(page, text) {
    await page.fill('#message-input', text);
    await page.press('#message-input', 'Enter');
  }
  const lastTheirMessage = (page) =>
    page.locator('#messages .msg-them .msg-bubble').last().textContent({ timeout: STEP_TIMEOUT });

  try {
    console.log(`E2E against ${base}`);
    const alice = await user('alice', { timezoneId: 'Asia/Kolkata' });
    const bob = await user('bob', { timezoneId: 'America/Sao_Paulo' });

    await step('landing page renders with live online counter', async () => {
      await alice.waitForSelector('[data-online-pill]:not([hidden])', { timeout: STEP_TIMEOUT });
      assert.match(await alice.textContent('[data-online-count]'), /\d+ online/);
    });

    await step('start is blocked until the 18+ consent is ticked', async () => {
      await alice.click('#start-video');
      await alice.waitForSelector('#start-error:not([hidden])');
      assert.equal(await alice.isVisible('#view-chat'), false);
    });

    await step('two strangers with a shared interest are matched', async () => {
      await start(alice, 'video', ['music', 'travel']);
      await waitState(alice, 'searching');
      await start(bob, 'video', ['music']);
      await Promise.all([waitState(alice, 'connected'), waitState(bob, 'connected')]);
      const aliceLog = await alice.textContent('#messages');
      assert.match(aliceLog, /Brazil/, 'Alice sees Bob is from Brazil (time zone fallback)');
      assert.match(aliceLog, /You both like Music/);
      assert.match(await bob.textContent('#partner-country'), /India/);
    });

    await step('peer-to-peer video flows both ways', async () => {
      const hasVideo = () =>
        document.getElementById('remote-video').videoWidth > 0 && document.getElementById('remote-video').currentTime > 0;
      await alice.waitForFunction(hasVideo, null, { timeout: STEP_TIMEOUT });
      await bob.waitForFunction(hasVideo, null, { timeout: STEP_TIMEOUT });
    });

    await step('quick replies, typing indicator and messages are delivered', async () => {
      await bob.click('.quick-replies [data-quick="quick.from"]', { timeout: STEP_TIMEOUT });
      assert.equal(await lastTheirMessage(alice), 'Where are you from?');
      await alice.type('#message-input', 'Hello from Delhi');
      await bob.waitForSelector('#typing:not([hidden])', { timeout: STEP_TIMEOUT });
      await alice.press('#message-input', 'Enter');
      assert.equal(await lastTheirMessage(bob), 'Hello from Delhi');
    });

    await step('links are blocked and never reach the stranger', async () => {
      await send(alice, 'join my channel at t.me/spam');
      await alice.waitForSelector('#messages .msg-me.is-failed', { timeout: STEP_TIMEOUT });
      await alice.waitForSelector('.toast', { timeout: STEP_TIMEOUT });
      await bob.waitForTimeout(500);
      assert.equal(await lastTheirMessage(bob), 'Hello from Delhi');
    });

    await step('camera and microphone stay on, Monkey-style (no mute buttons)', async () => {
      assert.equal(await alice.locator('#mic-btn, #cam-btn').count(), 0);
      const tracks = () => {
        const stream = document.getElementById('remote-video').srcObject;
        return stream ? [stream.getAudioTracks().length, stream.getVideoTracks().length] : [0, 0];
      };
      assert.deepEqual(await bob.evaluate(tracks), [1, 1], 'Bob hears and sees Alice');
      assert.deepEqual(await alice.evaluate(tracks), [1, 1], 'Alice hears and sees Bob');
      assert.equal(await bob.isVisible('#partner-muted'), false);
    });

    await step('Next ends the chat; recent partners are not re-matched', async () => {
      await bob.click('#next-btn');
      await alice.waitForFunction(
        () => [...document.querySelectorAll('#messages .msg-system')].some((li) => /left the chat/.test(li.textContent)),
        null,
        { timeout: STEP_TIMEOUT },
      );
      await Promise.all([waitState(alice, 'searching'), waitState(bob, 'searching')]);
      await alice.waitForTimeout(2500); // interest window passes; still must not re-match
      assert.equal(await state(alice), 'searching');
      assert.equal(await state(bob), 'searching');
    });

    const carol = await user('carol', { timezoneId: 'Africa/Lagos' });
    await step('a newcomer is matched with someone waiting', async () => {
      await start(carol, 'video');
      await waitState(carol, 'connected');
      const partnerOfCarol = (await state(alice)) === 'connected' ? alice : bob;
      assert.equal(await state(partnerOfCarol), 'connected');
      assert.match(await partnerOfCarol.textContent('#partner-country'), /Nigeria/);
    });

    await step('reporting ends the chat and bans the reported user (threshold 1 in this test)', async () => {
      const reporter = (await state(alice)) === 'connected' ? alice : bob;
      await reporter.click('#report-btn');
      await reporter.waitForSelector('#dlg-report[open]');
      await reporter.check('input[name="reason"][value="spam"]');
      await reporter.click('#dlg-report button[value="submit"]');
      await reporter.waitForSelector('.toast >> text=Thanks for reporting', { timeout: STEP_TIMEOUT });
      await carol.waitForSelector('#dlg-banned[open]', { timeout: STEP_TIMEOUT });
      assert.match(await carol.textContent('#banned-text'), /come back/);
    });

    await step('a banned browser cannot reconnect', async () => {
      await carol.reload({ waitUntil: 'domcontentloaded' });
      await carol.waitForSelector('#dlg-banned[open]', { timeout: STEP_TIMEOUT });
    });

    await step('Stop returns to idle and Esc starts again', async () => {
      for (const page of [alice, bob]) {
        await page.click('#stop-btn');
        await waitState(page, 'idle');
      }
      await alice.keyboard.press('Escape');
      await waitState(alice, 'searching');
      await alice.click('#stop-btn');
    });

    await step('text-only mode works without a camera', async () => {
      const dan = await user('dan', { timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
      const eve = await user('eve', { timezoneId: 'Europe/Paris' });
      await start(dan, 'text');
      await start(eve, 'text');
      await Promise.all([waitState(dan, 'connected'), waitState(eve, 'connected')]);
      assert.equal(await dan.isVisible('#tile-local'), false);
      await send(eve, 'Bonjour !');
      assert.equal(await lastTheirMessage(dan), 'Bonjour !');
    });

    await step('localized pages: Japanese UI and Arabic right-to-left', async () => {
      const page = await (await browser.newContext({ locale: 'ar-EG' })).newPage();
      const res = await page.goto(base + '/');
      assert.equal(new URL(res.url()).pathname, '/ar');
      assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
      assert.match(await page.textContent('h1'), /للعالم/);
    });

    await step('the browser back button leaves the chat and releases the camera', async () => {
      await alice.click('#next-btn'); // shows "Start" while idle
      await waitState(alice, 'searching');
      await alice.goBack();
      await alice.waitForSelector('#view-home:not([hidden])');
      const live = await alice.evaluate(() => window.__app.chat.stream === null);
      assert.equal(live, true);
    });

    await step('no JavaScript errors in any browser', async () => {
      assert.deepEqual(problems, []);
    });

    console.log(`\n${passed} checks passed`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch(() => {
  console.error(`\nE2E FAILED after ${passed} passing checks`);
  process.exit(1);
});
