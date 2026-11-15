#!/usr/bin/env node
// End-to-end test: real Chromium browsers with fake cameras go through the
// whole journey against the real server — intro, sign up, community
// guidelines, lobby, matching, WebRTC video, chat, link blocking, skipping,
// reporting, sign out / sign in and text mode.
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
  process.env.AUTH_ATTEMPTS_PER_MINUTE = '200'; // every test browser shares 127.0.0.1
  delete process.env.GOOGLE_CLIENT_ID; // email sign-up only (no network access to Google here)
  delete process.env.REQUIRE_SIGN_IN;
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
      // The browser logs every 4xx response; a wrong password (401) and a banned login (403) are expected here.
      const expected = /Failed to load resource: the server responded with a status of 40[13]/.test(msg.text());
      if (msg.type() === 'error' && !expected) problems.push(`${name}: console: ${msg.text()}`);
    });
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__app?.socket?.connected === true, null, { timeout: STEP_TIMEOUT });
    page.userName = name;
    return page;
  }
  const visible = (page, view) => page.waitForSelector(`#view-${view}:not([hidden])`, { timeout: STEP_TIMEOUT });
  const chatState = (page) => page.evaluate(() => window.__app.chat.state);
  const waitState = (page, value, timeout = STEP_TIMEOUT) =>
    page.waitForFunction((v) => document.getElementById('chat-layout').dataset.state === v, value, { timeout });
  const credentials = (page) => ({
    email: `${page.userName.toLowerCase()}@example.com`,
    password: `${page.userName}-password-123`,
  });

  /** Landing → Start → sign-up form → guidelines dialog. */
  async function signUp(page, { mode = 'video' } = {}) {
    await page.click(`#intro [data-start="${mode}"]`);
    await visible(page, 'auth');
    if (await page.isVisible('#auth-more')) await page.click('#auth-more');
    await page.click('#email-auth [data-tab="signup"]');
    const { email, password } = credentials(page);
    await page.fill('#auth-form [name=name]', page.userName);
    await page.fill('#auth-form [name=email]', email);
    await page.fill('#auth-form [name=password]', password);
    await page.click('#auth-form .auth-submit');
    await page.waitForSelector('#dlg-guidelines[open]', { timeout: STEP_TIMEOUT });
  }
  async function acceptGuidelines(page) {
    await page.check('#guide-form [name=age]');
    await page.check('#guide-form [name=terms]');
    await page.click('#guide-form button[value="agree"]');
    await visible(page, 'lobby');
  }
  async function enterLobby(page, opts) {
    await signUp(page, opts);
    await acceptGuidelines(page);
  }
  /** Lobby → (interests) → Start. */
  async function start(page, interests = []) {
    for (const tag of interests) await page.click(`#suggestions .chip-suggest[data-interest="${tag}"]`);
    await page.click('#lobby-start');
    await visible(page, 'chat');
  }
  async function send(page, text) {
    await page.fill('#message-input', text);
    await page.press('#message-input', 'Enter');
  }
  const lastTheirMessage = (page) =>
    page.locator('#messages .msg-them .msg-bubble').last().textContent({ timeout: STEP_TIMEOUT });
  const toastSays = (page, re) =>
    page.waitForFunction((src) => [...document.querySelectorAll('.toast')].some((el) => new RegExp(src).test(el.textContent)), re.source, {
      timeout: STEP_TIMEOUT,
    });

  try {
    console.log(`E2E against ${base}`);
    const alice = await user('Alice', { timezoneId: 'Asia/Kolkata' });
    const bob = await user('Bob', { timezoneId: 'America/Sao_Paulo' });

    await step('landing page: intro animation forms the name, live online counter', async () => {
      await alice.waitForSelector('#intro.is-formed', { timeout: STEP_TIMEOUT });
      await alice.waitForSelector('[data-online-pill]:not([hidden])', { timeout: STEP_TIMEOUT });
      assert.match(await alice.textContent('[data-online-count]'), /\d+ online/);
      assert.ok((await alice.locator('#people .person-card').count()) >= 8, 'cards band is filled');
      assert.equal(await alice.locator('.faq details').count(), 5);
    });

    await step('Start asks to sign in first — nobody is matched yet', async () => {
      await alice.click('#intro [data-start="video"]');
      await visible(alice, 'auth');
      assert.equal(await chatState(alice), 'idle');
      assert.equal(await alice.evaluate(() => window.__app.camera.live), false, 'no camera before signing in');
    });

    await step('sign-up form validates and creates the account', async () => {
      await alice.click('#email-auth [data-tab="signup"]');
      await alice.fill('#auth-form [name=name]', 'Alice');
      await alice.fill('#auth-form [name=email]', 'alice@example.com');
      await alice.fill('#auth-form [name=password]', 'short');
      await alice.click('#auth-form .auth-submit');
      assert.match(await alice.textContent('#auth-error'), /at least 8 characters/);
      await alice.fill('#auth-form [name=password]', credentials(alice).password);
      await alice.click('#auth-form .auth-submit');
      await alice.waitForSelector('#dlg-guidelines[open]', { timeout: STEP_TIMEOUT });
    });

    await step('guidelines need both boxes ticked, then the lobby opens with a camera preview', async () => {
      await alice.click('#guide-form button[value="agree"]');
      await alice.waitForSelector('#guide-error:not([hidden])');
      assert.equal(await alice.isVisible('#dlg-guidelines'), true);
      await acceptGuidelines(alice);
      await alice.waitForSelector('#lobby-card[data-media="ready"]', { timeout: STEP_TIMEOUT });
      await alice.waitForFunction(() => document.getElementById('lobby-video').videoWidth > 0, null, { timeout: STEP_TIMEOUT });
      assert.match(await alice.textContent('#lobby-hello'), /Hi, Alice!/);
      assert.equal(await alice.isVisible('#view-lobby [data-account] .avatar-btn'), true);
    });

    await step('matching starts only when the person presses Start', async () => {
      await alice.waitForTimeout(800);
      assert.equal(await chatState(alice), 'idle');
      assert.equal(await alice.isVisible('#view-chat'), false);
    });

    await step('two strangers with a shared interest are matched', async () => {
      await start(alice, ['music', 'travel']);
      await waitState(alice, 'searching');
      await enterLobby(bob);
      await start(bob, ['music']);
      await Promise.all([waitState(alice, 'connected'), waitState(bob, 'connected')]);
      const aliceLog = await alice.textContent('#messages');
      assert.match(aliceLog, /Brazil/, 'Alice sees Bob is from Brazil (time zone fallback)');
      assert.match(aliceLog, /You both like Music/);
      assert.match(await bob.textContent('#partner-country'), /India/);
      assert.doesNotMatch(aliceLog, /Bob|bob@example/, 'names and emails are never shared');
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
    });

    await step('Esc skips to the next person; recent partners are not re-matched', async () => {
      await bob.click('#remote-video', { force: true }); // focus the page, not the message box
      await bob.keyboard.press('Escape');
      await alice.waitForFunction(
        () => [...document.querySelectorAll('#messages .msg-system')].some((li) => /left the chat/.test(li.textContent)),
        null,
        { timeout: STEP_TIMEOUT },
      );
      await Promise.all([waitState(alice, 'searching'), waitState(bob, 'searching')]);
      await alice.waitForTimeout(2500); // interest window passes; still must not re-match
      assert.equal(await chatState(alice), 'searching');
      assert.equal(await chatState(bob), 'searching');
    });

    const carol = await user('Carol', { timezoneId: 'Africa/Lagos' });
    await step('a newcomer is matched with someone waiting', async () => {
      await enterLobby(carol);
      await start(carol);
      await waitState(carol, 'connected');
      const partnerOfCarol = (await chatState(alice)) === 'connected' ? alice : bob;
      assert.equal(await chatState(partnerOfCarol), 'connected');
      assert.match(await partnerOfCarol.textContent('#partner-country'), /Nigeria/);
    });

    await step('reporting ends the chat and bans the reported account (threshold 1 in this test)', async () => {
      const reporter = (await chatState(alice)) === 'connected' ? alice : bob;
      await reporter.click('#report-btn');
      await reporter.waitForSelector('#dlg-report[open]');
      await reporter.check('input[name="reason"][value="spam"]');
      await reporter.click('#dlg-report button[value="submit"]');
      await toastSays(reporter, /Thanks for reporting/);
      await carol.waitForSelector('#dlg-banned[open]', { timeout: STEP_TIMEOUT });
      assert.match(await carol.textContent('#banned-text'), /come back/);
    });

    await step('a banned account cannot come back, even from a fresh browser', async () => {
      await carol.reload({ waitUntil: 'domcontentloaded' });
      await carol.waitForSelector('#dlg-banned[open]', { timeout: STEP_TIMEOUT });
      const fresh = await user('Carol', { timezoneId: 'Africa/Lagos' });
      await fresh.click('#intro [data-start="video"]');
      await visible(fresh, 'auth');
      await fresh.fill('#auth-form [name=email]', credentials(fresh).email);
      await fresh.fill('#auth-form [name=password]', credentials(fresh).password);
      await fresh.click('#auth-form .auth-submit');
      await fresh.waitForSelector('#dlg-banned[open]', { timeout: STEP_TIMEOUT });
      await fresh.context().close();
    });

    await step('Stop goes back to the lobby; Start finds someone again', async () => {
      for (const page of [alice, bob]) {
        await page.click('#stop-btn');
        await visible(page, 'lobby');
        assert.equal(await chatState(page), 'idle');
        assert.equal(await page.evaluate(() => window.__app.camera.live), true, 'preview keeps running in the lobby');
      }
      await start(alice);
      await waitState(alice, 'searching');
      await alice.click('#stop-btn');
      await visible(alice, 'lobby');
    });

    const dave = await user('Dave', { timezoneId: 'Australia/Sydney' });
    await step('"I disagree" goes back home; Start asks again', async () => {
      await signUp(dave);
      await dave.click('#guide-form button[value="disagree"]');
      await visible(dave, 'home');
      await toastSays(dave, /accept the guidelines/);
      assert.equal(await dave.evaluate(() => window.__app.camera.live), false);
      await dave.click('#intro [data-start="video"]');
      await dave.waitForSelector('#dlg-guidelines[open]', { timeout: STEP_TIMEOUT }); // already signed in
      await acceptGuidelines(dave);
    });

    await step('sign out, then signing back in goes straight to the lobby', async () => {
      await dave.click('#view-lobby [data-account] .avatar-btn');
      await dave.click('#view-lobby [data-account] [data-signout]');
      await visible(dave, 'home');
      await dave.waitForSelector('#view-home [data-signin]:not([hidden])');
      assert.equal(await dave.evaluate(() => window.__app.camera.live), false, 'camera released');
      await dave.click('#intro [data-start="video"]');
      await visible(dave, 'auth');
      await dave.click('#email-auth [data-tab="signin"]');
      await dave.fill('#auth-form [name=email]', credentials(dave).email);
      await dave.fill('#auth-form [name=password]', 'wrong-password');
      await dave.click('#auth-form .auth-submit');
      await dave.waitForSelector('#auth-error:not([hidden])', { timeout: STEP_TIMEOUT });
      assert.match(await dave.textContent('#auth-error'), /Wrong email or password/);
      await dave.fill('#auth-form [name=password]', credentials(dave).password);
      await dave.click('#auth-form .auth-submit');
      await visible(dave, 'lobby');
      assert.equal(await dave.isVisible('#dlg-guidelines'), false);
    });

    await step('text-only mode never turns the camera on', async () => {
      const eve = await user('Eve', { timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
      const frank = await user('Frank', { timezoneId: 'Europe/Paris' });
      for (const page of [eve, frank]) {
        await enterLobby(page, { mode: 'text' });
        assert.equal(await page.getAttribute('#lobby-card', 'data-mode'), 'text');
        assert.equal(await page.evaluate(() => window.__app.camera.live), false);
        await start(page);
      }
      await Promise.all([waitState(eve, 'connected'), waitState(frank, 'connected')]);
      assert.equal(await eve.isVisible('#tile-local'), false);
      await send(frank, 'Bonjour !');
      assert.equal(await lastTheirMessage(eve), 'Bonjour !');
      assert.equal(await eve.evaluate(() => window.__app.camera.live), false);
    });

    await step('localized pages: Arabic right-to-left', async () => {
      const page = await (await browser.newContext({ locale: 'ar-EG' })).newPage();
      const res = await page.goto(base + '/');
      assert.equal(new URL(res.url()).pathname, '/ar');
      assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
      assert.match(await page.textContent('h1'), /للعالم/);
    });

    await step('the browser back button walks back chat → lobby → home and releases the camera', async () => {
      await start(alice);
      await waitState(alice, 'searching');
      await alice.goBack();
      await visible(alice, 'lobby');
      assert.equal(await chatState(alice), 'idle');
      await alice.goBack();
      await visible(alice, 'home');
      assert.equal(await alice.evaluate(() => window.__app.camera.live), false);
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
