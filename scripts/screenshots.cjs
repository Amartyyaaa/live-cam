#!/usr/bin/env node
// Captures the UI screenshots in docs/screenshots/.
//
// Real browsers, real server, real WebRTC — only the cameras are fake: each
// browser gets an animated illustrated "person" drawn on a <canvas>, so the
// screenshots show what a conversation looks like without real people.
//
//   npm run screenshots

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, devices } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');

const PEOPLE = {
  priya: { bg: ['#ffc59e', '#ff7a5c'], shirt: '#2d2a5a', skin: '#c98d66', shade: '#b07652', hair: '#24140c' },
  lucas: { bg: ['#7c5cff', '#21b6c4'], shirt: '#ffd166', skin: '#8d5a3b', shade: '#754729', hair: '#120c0e' },
  aiko: { bg: ['#9be7c4', '#3a8dde'], shirt: '#ff5b8a', skin: '#f2cfb3', shade: '#ddb497', hair: '#1c1412' },
};

// Runs inside the page before any app code: replaces the camera with a canvas.
function fakeCamera({ person, cameras }) {
  const draw = (ctx, w, h, t) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, person.bg[0]);
    g.addColorStop(1, person.bg[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(w * 0.64, h * 0.08, w * 0.26, h * 0.4);
    ctx.fillRect(w * 0.08, h * 0.12, w * 0.14, h * 0.22);
    for (let i = 0; i < 7; i++) {
      ctx.beginPath();
      ctx.arc(((i * 157) % w) + Math.sin(t * 0.6 + i) * 10, (i * 71) % (h * 0.55), 14 + (i % 3) * 12, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.09)';
      ctx.fill();
    }
    const bob = Math.sin(t * 1.4) * 5;
    const cx = w / 2 + Math.sin(t * 0.6) * 8;
    ctx.fillStyle = person.shirt;
    ctx.beginPath();
    ctx.ellipse(cx, h * 1.04 + bob, w * 0.34, h * 0.4, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = person.shade;
    ctx.fillRect(cx - w * 0.05, h * 0.5 + bob, w * 0.1, h * 0.17);
    ctx.fillStyle = person.hair;
    ctx.beginPath();
    ctx.ellipse(cx, h * 0.4 + bob, w * 0.135, h * 0.215, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = person.skin;
    ctx.beginPath();
    ctx.ellipse(cx, h * 0.43 + bob, w * 0.112, h * 0.185, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = person.hair;
    ctx.beginPath();
    ctx.ellipse(cx, h * 0.3 + bob, w * 0.125, h * 0.09, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    const blink = t % 4 < 0.15;
    ctx.fillStyle = '#21140f';
    for (const dx of [-0.042, 0.042]) {
      ctx.beginPath();
      ctx.ellipse(cx + w * dx, h * 0.43 + bob, 6, blink ? 1 : 7, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = '#6e2f25';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, h * 0.475 + bob, w * 0.04, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  };

  const makeStream = () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
    const ctx = canvas.getContext('2d');
    const t0 = performance.now();
    setInterval(() => draw(ctx, 640, 480, (performance.now() - t0) / 1000), 33);
    draw(ctx, 640, 480, 0);
    const stream = canvas.captureStream(30);
    try {
      const ac = new AudioContext();
      const dest = ac.createMediaStreamDestination();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(dest);
      osc.start();
      stream.addTrack(dest.stream.getAudioTracks()[0]);
    } catch {
      /* video only */
    }
    return stream;
  };

  navigator.mediaDevices.getUserMedia = async () => makeStream();
  navigator.mediaDevices.enumerateDevices = async () => [
    ...Array.from({ length: cameras }, (_, i) => ({ kind: 'videoinput', deviceId: `cam${i}`, label: i ? 'Back camera' : 'Front camera', groupId: 'g' })),
    { kind: 'audioinput', deviceId: 'mic0', label: 'Microphone', groupId: 'g' },
  ];
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiyo-shots-'));
  process.env.AUTH_ATTEMPTS_PER_MINUTE = '200';
  delete process.env.GOOGLE_CLIENT_ID; // the email form photographs the same everywhere
  delete process.env.REQUIRE_SIGN_IN;
  const { loadConfig } = await import(path.join(ROOT, 'server/config.js'));
  const { createServer } = await import(path.join(ROOT, 'server/app.js'));
  const server = createServer(loadConfig(), { logger: { ...console, info() {}, warn() {} } });
  const { port } = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
  const phone = devices['Pixel 7'];

  async function open(name, { device = desktop, person, cameras = 1, timezoneId = 'Europe/Berlin', locale = 'en-US', path: url = '/' } = {}) {
    const context = await browser.newContext({ ...device, timezoneId, locale, colorScheme: 'dark' });
    if (person) await context.addInitScript(fakeCamera, { person: PEOPLE[person], cameras });
    const page = await context.newPage();
    page.on('pageerror', (err) => console.error(`${name}: ${err.message}`));
    await page.goto(base + url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__app?.socket?.connected === true);
    return page;
  }
  const shot = async (page, file, opts = {}) => {
    if (opts.settle !== 0) await page.waitForTimeout(opts.settle ?? 700);
    await page.screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 88, ...opts.screenshot });
    console.log(`  ✓ ${file}`);
  };
  const state = (page, value) =>
    page.waitForFunction((v) => document.getElementById('chat-layout').dataset.state === v, value, { timeout: 20000 });
  const formed = (page) => page.waitForSelector('#intro.is-formed', { timeout: 15000 });
  let accounts = 0;
  /** Landing → Start → create an account → accept the guidelines → lobby. */
  async function enter(page, { mode = 'video', name = 'Sam', shots = {} } = {}) {
    await formed(page);
    await page.click(`#intro [data-start="${mode}"]`);
    await page.waitForSelector('#view-auth:not([hidden])');
    await page.click('#email-auth [data-tab="signup"]');
    await page.fill('#auth-form [name=name]', name);
    await page.fill('#auth-form [name=email]', `${name.toLowerCase()}${++accounts}@example.com`);
    await page.fill('#auth-form [name=password]', 'a-long-password');
    if (shots.signin) await shot(page, shots.signin, { settle: 300 });
    await page.click('#auth-form .auth-submit');
    await page.waitForSelector('#dlg-guidelines[open]');
    if (shots.guidelines) {
      await page.check('#guide-form [name=age]');
      await shot(page, shots.guidelines, { settle: 400 });
    }
    await page.check('#guide-form [name=age]');
    await page.check('#guide-form [name=terms]');
    await page.click('#guide-form button[value="agree"]');
    await page.waitForSelector('#view-lobby:not([hidden])');
  }
  async function start(page, { interests = [] } = {}) {
    for (const tag of interests) await page.click(`#suggestions .chip-suggest[data-interest="${tag}"]`);
    await page.click('#lobby-start');
    await page.waitForSelector('#view-chat:not([hidden])');
  }
  const say = async (page, text) => {
    await page.fill('#message-input', text);
    await page.press('#message-input', 'Enter');
    await page.waitForTimeout(250);
  };

  try {
    // ------------------------------------------------------------ landing
    const intro = await open('intro');
    await intro.waitForTimeout(1300);
    await shot(intro, 'intro-words.jpg', { settle: 0 });
    await formed(intro);
    await shot(intro, 'home-desktop.jpg', { settle: 1200 });
    await intro.evaluate(async () => {
      // Scroll through once so every lazy image is loaded for the full-page shot.
      for (let y = 0; y < document.documentElement.scrollHeight; y += 500) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      window.scrollTo(0, 0);
    });
    await shot(intro, 'home-full.jpg', { screenshot: { fullPage: true, scale: 'css', quality: 80 } });
    const homePhone = await open('home-phone', { device: phone });
    await formed(homePhone);
    await shot(homePhone, 'home-mobile.jpg', { settle: 1200 });
    const homeAr = await open('home-ar', { path: '/ar', locale: 'ar-EG' });
    await formed(homeAr);
    await shot(homeAr, 'home-arabic-rtl.jpg', { settle: 1200 });
    const homeHi = await open('home-hi', { device: phone, path: '/hi', locale: 'hi-IN' });
    await formed(homeHi);
    await shot(homeHi, 'home-hindi-mobile.jpg', { settle: 1200 });

    // ------------------------------------------------------------ sign in → guidelines → lobby
    const solo = await open('solo', { person: 'aiko', timezoneId: 'Asia/Tokyo' });
    await enter(solo, { name: 'Aiko', shots: { signin: 'signin-desktop.jpg', guidelines: 'guidelines-dialog.jpg' } });
    await solo.click('#suggestions .chip-suggest[data-interest="anime"]');
    await shot(solo, 'lobby-desktop.jpg', { settle: 1000 });

    // ------------------------------------------------------------ searching (alone in the queue)
    await start(solo);
    await state(solo, 'searching');
    await shot(solo, 'chat-searching.jpg', { settle: 1800 });
    await solo.click('#stop-btn');

    // ------------------------------------------------------------ video chat: desktop ↔ phone
    const priya = await open('priya', { person: 'priya', timezoneId: 'Asia/Kolkata' });
    const lucas = await open('lucas', { device: phone, person: 'lucas', cameras: 2, timezoneId: 'America/Sao_Paulo' });
    await enter(priya, { name: 'Priya' });
    await enter(lucas, { name: 'Lucas' });
    await shot(lucas, 'lobby-mobile.jpg', { settle: 1000 });
    await start(priya, { interests: ['music', 'travel'] });
    await state(priya, 'searching');
    await start(lucas, { interests: ['travel', 'food'] });
    await Promise.all([state(priya, 'connected'), state(lucas, 'connected')]);
    await priya.waitForFunction(() => document.getElementById('remote-video').currentTime > 0.5);
    await lucas.waitForFunction(() => document.getElementById('remote-video').currentTime > 0.5);
    await priya.click('.quick-replies [data-quick="quick.hi"]');
    await say(lucas, 'Olá! Greetings from São Paulo 🇧🇷');
    await say(priya, "Nice! I'm in Mumbai. Have you ever been to India?");
    await say(lucas, 'Not yet, but it is #1 on my travel list ✈️');
    await lucas.fill('#message-input', 'What should I');
    await lucas.dispatchEvent('#message-input', 'input');
    await shot(priya, 'chat-desktop.jpg', { settle: 900 });
    await lucas.fill('#message-input', '');
    await shot(lucas, 'chat-mobile.jpg');

    await priya.click('#report-btn');
    await priya.waitForSelector('#dlg-report[open]');
    await priya.check('input[name="reason"][value="spam"]');
    await shot(priya, 'report-dialog.jpg', { settle: 400 });
    await priya.click('#dlg-report button[value="cancel"]');

    await lucas.click('#settings-btn');
    await lucas.waitForSelector('#dlg-settings[open]');
    await shot(lucas, 'settings-mobile.jpg', { settle: 500 });
    await lucas.click('#dlg-settings button[value="done"]');

    // ------------------------------------------------------------ text-only chat
    const textA = await open('textA', { timezoneId: 'Europe/Madrid', path: '/es', locale: 'es-ES' });
    const textB = await open('textB', { timezoneId: 'America/Mexico_City', path: '/es', locale: 'es-MX' });
    await enter(textA, { mode: 'text', name: 'Lucía' });
    await enter(textB, { mode: 'text', name: 'Diego' });
    await start(textA, { interests: ['movies'] });
    await state(textA, 'searching');
    await start(textB, { interests: ['movies'] });
    await Promise.all([state(textA, 'connected'), state(textB, 'connected')]);
    await say(textB, '¡Hola! ¿Qué película viste últimamente?');
    await say(textA, 'Hola 😄 Vi una de Studio Ghibli, ¡increíble!');
    await say(textB, '¡Me encanta Ghibli! ¿Cuál?');
    await shot(textA, 'chat-text-spanish.jpg');

    console.log(`Saved to ${path.relative(ROOT, OUT)}/`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
