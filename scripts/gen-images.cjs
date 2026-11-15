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
    const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await og.goto(base + '/', { waitUntil: 'networkidle' });
    const visual = await og.$eval('.hero-visual', (el) => el.outerHTML);
    const logo = await og.$eval('.site-header .logo-mark', (el) => el.outerHTML);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
      <link rel="stylesheet" href="/css/app.css">
      <style>
        *, *::before, *::after { animation: none !important; }
        html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
        .og {
          display: grid; grid-template-columns: 1fr 500px; align-items: center; gap: 24px;
          width: 1200px; height: 630px; padding: 0 64px 0 76px; box-sizing: border-box;
          background:
            radial-gradient(55% 75% at 84% 52%, rgba(124, 92, 255, .16), transparent 70%),
            radial-gradient(45% 60% at 4% 0%, rgba(255, 91, 46, .2), transparent 70%),
            #fff6ee;
          color-scheme: light;
        }
        .og .brand { font-size: 46px; color: #1d1426; }
        .og h1 { margin: 34px 0 20px; font-family: var(--font-display); font-size: 96px; font-weight: 800;
                 line-height: .95; letter-spacing: -0.045em; color: #1d1426; }
        .og h1 em { font-style: normal; background: linear-gradient(100deg, #ff5b2e 5%, #ff2e7a 50%, #7c5cff 95%);
                    -webkit-background-clip: text; background-clip: text; color: transparent; }
        .og p { max-width: 540px; font-size: 29px; line-height: 1.35; color: #5b5066; }
        .og .hero-visual { width: 500px; }
        .og .orbit { --spin: 0s; }
      </style></head><body>
      <div class="og">
        <div>
          <span class="brand">${logo}<span>${config.appName}</span></span>
          <h1>Say hi to the <em>world</em>.</h1>
          <p>Free random video chat with people from every corner of the planet.</p>
        </div>
        ${visual}
      </div></body></html>`;
    await og.route(base + '/__og', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
    await og.goto(base + '/__og', { waitUntil: 'networkidle' });
    await og.evaluate(() => document.fonts.ready);
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
