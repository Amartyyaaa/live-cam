#!/usr/bin/env node
// Renders the PNG app icons and the social preview image (og-image.png)
// from the real CSS and logo, so they always match the design.
//
//   npm run gen:images

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const mark = (scale) => `
  <g transform="translate(32 32) scale(${scale}) translate(-32 -32)">
    <circle cx="23" cy="32" r="15" fill="#FF5B2E"/>
    <circle cx="41" cy="32" r="15" fill="#7C5CFF"/>
    <path d="M32 20A15 15 0 0 1 32 44A15 15 0 0 1 32 20Z" fill="#FFB21E"/>
  </g>`;

async function main() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hiyo-img-'));
  const { loadConfig } = await import(path.join(ROOT, 'server/config.js'));
  const { createServer } = await import(path.join(ROOT, 'server/app.js'));
  const config = loadConfig();
  const server = createServer(config, { logger: { ...console, info() {}, warn() {} } });
  const { port } = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    // ---------------------------------------------------------------- icons
    const page = await browser.newPage();
    const icon = async (file, size, { rounded, scale }) => {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<html><body style="margin:0;background:transparent">
          <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
            <rect width="64" height="64" rx="${rounded ? 16 : 0}" fill="#1D1426"/>${mark(scale)}
          </svg></body></html>`,
      );
      await page.screenshot({ path: path.join(PUBLIC, file), omitBackground: true });
      console.log(`  ✓ public/${file}`);
    };
    fs.mkdirSync(path.join(PUBLIC, 'icons'), { recursive: true });
    await icon('icons/favicon-32.png', 32, { rounded: true, scale: 1.1 });
    await icon('icons/icon-192.png', 192, { rounded: true, scale: 1 });
    await icon('icons/icon-512.png', 512, { rounded: true, scale: 1 });
    await icon('icons/maskable-512.png', 512, { rounded: false, scale: 0.8 }); // Android safe zone
    await icon('icons/apple-touch-icon.png', 180, { rounded: false, scale: 0.92 }); // iOS rounds corners itself

    // ------------------------------------------------------------- og image
    // The real landing hero (word-cloud intro + headline) without the buttons.
    const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, locale: 'en-US', bypassCSP: true });
    const ogCss = `
      .header-actions, .intro-actions, .scroll-cue, .band { display: none !important; }
      .intro-copy { opacity: 1 !important; transform: none !important; animation: none !important; }
      .intro-title { font-size: 92px !important; }
      .intro-sub { font-size: 26px !important; }`;
    await og.route(`${base}/`, async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace('</head>', `<style>${ogCss}</style></head>`);
      const headers = { ...res.headers() };
      delete headers['content-encoding']; // the body was decompressed by fetch()
      delete headers['content-length'];
      await route.fulfill({ status: res.status(), headers, body });
    });
    await og.goto(`${base}/`, { waitUntil: 'load' });
    await og.waitForSelector('#intro.is-formed', { timeout: 15000 });
    await og.waitForTimeout(1200);
    await og.screenshot({ path: path.join(PUBLIC, 'og-image.png') });
    console.log('  ✓ public/og-image.png');
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
