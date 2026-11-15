#!/usr/bin/env node
// Builds the landing-page images:
//   public/img/people/1..8.webp       illustrated portraits for the cards band
//   public/img/showcase-*.webp        device mockups, from docs/screenshots
//
//   npm run gen:landing   (after `npm run screenshots`)

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'img');

const PEOPLE = [
  { bg: ['#f3e9dc', '#cfd8e6'], skin: '#8d5a3b', hair: 'curly', hairColor: '#1d1411', shirt: '#f2f2f2', smile: 0.9 },
  { bg: ['#dfe7f5', '#f7e8f0'], skin: '#f1c9a5', hair: 'long', hairColor: '#2a1c18', shirt: '#2c2b45', glasses: true, smile: 0.6, tilt: -0.06 },
  { bg: ['#f6efe1', '#e2e9d9'], skin: '#5c3a26', hair: 'buzz', hairColor: '#120c0a', shirt: '#e4572e', beard: true, smile: 0.8 },
  { bg: ['#e8e2f6', '#f4ead9'], skin: '#c68e63', hair: 'bun', hairColor: '#24160f', shirt: '#f5f0e6', earrings: true, smile: 1 },
  { bg: ['#e3eef3', '#f5e4dc'], skin: '#e8b996', hair: 'short', hairColor: '#6b4a2e', shirt: '#1f3b5a', headphones: true, smile: 0.7, tilt: 0.05 },
  { bg: ['#f4e5ea', '#dfe9f4'], skin: '#b07a52', hair: 'hijab', hairColor: '#3b2a4f', shirt: '#3b2a4f', smile: 0.85 },
  { bg: ['#efe9df', '#dbe5ee'], skin: '#d29a6e', hair: 'cap', hairColor: '#1a1110', shirt: '#f1f1f1', capColor: '#d94848', smile: 0.95 },
  { bg: ['#e4ecf6', '#f6ecdc'], skin: '#7a4a2e', hair: 'long', hairColor: '#0f0b0a', shirt: '#f0d24a', earrings: true, smile: 0.75, tilt: 0.04 },
];

// Runs in the browser: draws one person on a canvas and returns a WebP data URL.
function drawPerson(p) {
  const W = 640;
  const H = 800;
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d');
  const shade = (hex, amt) => {
    const n = parseInt(hex.slice(1), 16);
    const c = (v) => Math.max(0, Math.min(255, Math.round(v + amt)));
    return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
  };
  const ellipse = (x, y, rx, ry, color, rot = 0) => {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };

  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, p.bg[0]);
  g.addColorStop(1, p.bg[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.35;
  ellipse(W * 0.85, H * 0.18, 120, 120, '#ffffff');
  ellipse(W * 0.1, H * 0.62, 90, 90, '#ffffff');
  ctx.globalAlpha = 1;

  const cx = W / 2;
  const hy = H * 0.4;
  ctx.save();
  ctx.translate(cx, hy);
  ctx.rotate(p.tilt || 0);
  ctx.translate(-cx, -hy);

  // hair behind the head
  if (p.hair === 'long') {
    ctx.beginPath();
    ctx.moveTo(cx - 175, hy - 40);
    ctx.quadraticCurveTo(cx - 205, hy + 230, cx - 150, hy + 330);
    ctx.lineTo(cx + 150, hy + 330);
    ctx.quadraticCurveTo(cx + 205, hy + 230, cx + 175, hy - 40);
    ctx.closePath();
    ctx.fillStyle = p.hairColor;
    ctx.fill();
  }
  if (p.hair === 'hijab') {
    ctx.beginPath();
    ctx.moveTo(cx - 190, H);
    ctx.quadraticCurveTo(cx - 230, hy + 80, cx - 170, hy - 90);
    ctx.quadraticCurveTo(cx, hy - 250, cx + 170, hy - 90);
    ctx.quadraticCurveTo(cx + 230, hy + 80, cx + 190, H);
    ctx.closePath();
    ctx.fillStyle = p.hairColor;
    ctx.fill();
  }

  // shoulders
  ctx.beginPath();
  ctx.moveTo(cx - 300, H);
  ctx.quadraticCurveTo(cx - 290, hy + 200, cx - 120, hy + 185);
  ctx.lineTo(cx + 120, hy + 185);
  ctx.quadraticCurveTo(cx + 290, hy + 200, cx + 300, H);
  ctx.closePath();
  ctx.fillStyle = p.shirt;
  ctx.fill();
  // collar / neck
  ctx.fillStyle = shade(p.skin, -22);
  ctx.beginPath();
  ctx.moveTo(cx - 55, hy + 110);
  ctx.lineTo(cx - 60, hy + 190);
  ctx.quadraticCurveTo(cx, hy + 235, cx + 60, hy + 190);
  ctx.lineTo(cx + 55, hy + 110);
  ctx.closePath();
  ctx.fill();
  if (p.hair === 'hijab') {
    ctx.beginPath();
    ctx.moveTo(cx - 150, hy + 60);
    ctx.quadraticCurveTo(cx, hy + 260, cx + 150, hy + 60);
    ctx.lineTo(cx + 170, hy + 230);
    ctx.quadraticCurveTo(cx, hy + 300, cx - 170, hy + 230);
    ctx.closePath();
    ctx.fillStyle = shade(p.hairColor, 12);
    ctx.fill();
  }

  // ears + head
  if (p.hair !== 'hijab') {
    ellipse(cx - 128, hy + 10, 22, 34, shade(p.skin, -10));
    ellipse(cx + 128, hy + 10, 22, 34, shade(p.skin, -10));
  }
  ellipse(cx, hy, 128, 158, p.skin);
  ctx.globalAlpha = 0.18;
  ellipse(cx - 60, hy + 40, 26, 16, '#ff6f61');
  ellipse(cx + 60, hy + 40, 26, 16, '#ff6f61');
  ctx.globalAlpha = 1;

  // hair on top
  ctx.fillStyle = p.hairColor;
  if (p.hair === 'short') {
    ctx.beginPath();
    ctx.ellipse(cx, hy - 80, 140, 92, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - 132, hy - 70);
    ctx.quadraticCurveTo(cx - 40, hy - 40, cx + 40, hy - 95);
    ctx.quadraticCurveTo(cx + 110, hy - 60, cx + 135, hy - 60);
    ctx.lineTo(cx + 140, hy - 90);
    ctx.lineTo(cx - 140, hy - 90);
    ctx.fill();
  } else if (p.hair === 'buzz') {
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.ellipse(cx, hy - 60, 132, 100, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  } else if (p.hair === 'curly') {
    for (let i = 0; i < 26; i++) {
      const a = Math.PI + (i / 25) * Math.PI;
      ellipse(cx + Math.cos(a) * 140, hy - 40 + Math.sin(a) * 135, 46, 46, p.hairColor);
    }
    ellipse(cx, hy - 120, 120, 70, p.hairColor);
  } else if (p.hair === 'long' || p.hair === 'bun') {
    ctx.beginPath();
    ctx.ellipse(cx, hy - 70, 142, 100, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - 140, hy - 70);
    ctx.quadraticCurveTo(cx - 20, hy - 120, cx + 30, hy - 40);
    ctx.quadraticCurveTo(cx + 100, hy - 110, cx + 140, hy - 70);
    ctx.fill();
    if (p.hair === 'bun') ellipse(cx, hy - 205, 62, 56, p.hairColor);
  } else if (p.hair === 'cap') {
    ctx.beginPath();
    ctx.ellipse(cx, hy - 72, 140, 104, 0, Math.PI, Math.PI * 2);
    ctx.fillStyle = p.capColor;
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + 70, hy - 72, 150, 26, -0.05, 0, Math.PI * 2);
    ctx.fillStyle = shade(p.capColor, -30);
    ctx.fill();
  }

  // face
  const eyeY = hy + 6;
  ctx.strokeStyle = '#1b120e';
  ctx.lineCap = 'round';
  ctx.lineWidth = 7;
  for (const dx of [-48, 48]) {
    ellipse(cx + dx, eyeY, 13, 15, '#1b120e');
    ellipse(cx + dx + 4, eyeY - 5, 4, 4, '#ffffff');
    ctx.beginPath();
    ctx.moveTo(cx + dx - 24, eyeY - 34 + (dx > 0 ? -3 : 0));
    ctx.quadraticCurveTo(cx + dx, eyeY - 44, cx + dx + 24, eyeY - 34);
    ctx.stroke();
  }
  ctx.lineWidth = 5;
  ctx.strokeStyle = shade(p.skin, -45);
  ctx.beginPath();
  ctx.moveTo(cx - 4, eyeY + 12);
  ctx.quadraticCurveTo(cx - 14, eyeY + 52, cx + 6, eyeY + 56);
  ctx.stroke();
  // smile
  const sw = 34 + 22 * (p.smile ?? 0.7);
  ctx.beginPath();
  ctx.moveTo(cx - sw, eyeY + 82);
  ctx.quadraticCurveTo(cx, eyeY + 82 + 46 * (p.smile ?? 0.7), cx + sw, eyeY + 82);
  ctx.closePath();
  ctx.fillStyle = '#5a1f1a';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - sw + 10, eyeY + 86);
  ctx.quadraticCurveTo(cx, eyeY + 100, cx + sw - 10, eyeY + 86);
  ctx.lineTo(cx + sw - 14, eyeY + 84);
  ctx.lineTo(cx - sw + 14, eyeY + 84);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  if (p.beard) {
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(cx - 118, hy + 40);
    ctx.quadraticCurveTo(cx - 110, hy + 175, cx, hy + 168);
    ctx.quadraticCurveTo(cx + 110, hy + 175, cx + 118, hy + 40);
    ctx.quadraticCurveTo(cx + 70, hy + 150, cx, hy + 140);
    ctx.quadraticCurveTo(cx - 70, hy + 150, cx - 118, hy + 40);
    ctx.fillStyle = p.hairColor;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (p.glasses) {
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 7;
    for (const dx of [-50, 50]) {
      ctx.beginPath();
      ctx.roundRect(cx + dx - 38, eyeY - 28, 76, 58, 18);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - 12, eyeY - 6);
    ctx.lineTo(cx + 12, eyeY - 6);
    ctx.stroke();
  }
  if (p.earrings) {
    ellipse(cx - 130, hy + 50, 9, 9, '#f5c542');
    ellipse(cx + 130, hy + 50, 9, 9, '#f5c542');
  }
  if (p.headphones) {
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 22;
    ctx.beginPath();
    ctx.ellipse(cx, hy - 20, 160, 165, 0, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
    ellipse(cx - 150, hy + 10, 34, 52, '#2b2b2b');
    ellipse(cx + 150, hy + 10, 34, 52, '#2b2b2b');
  }
  ctx.restore();
  return canvas.toDataURL('image/webp', 0.86);
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'people'), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<html><body></body></html>');
  for (const [i, person] of PEOPLE.entries()) {
    const dataUrl = await page.evaluate(drawPerson, person);
    const file = path.join(OUT, 'people', `${i + 1}.webp`);
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`  ✓ ${path.relative(ROOT, file)}`);
  }

  const shrink = async (src, dest, width) => {
    const file = path.join(ROOT, 'docs', 'screenshots', src);
    if (!fs.existsSync(file)) return console.warn(`  ! missing ${src} — run npm run screenshots first`);
    const b64 = fs.readFileSync(file).toString('base64');
    const dataUrl = await page.evaluate(
      async ({ b64, width }) => {
        const img = new Image();
        img.src = `data:image/jpeg;base64,${b64}`;
        await img.decode();
        const canvas = Object.assign(document.createElement('canvas'), {
          width,
          height: Math.round((img.height / img.width) * width),
        });
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/webp', 0.82);
      },
      { b64, width },
    );
    fs.writeFileSync(path.join(OUT, dest), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`  ✓ public/img/${dest}`);
  };
  await shrink('chat-desktop.jpg', 'showcase-desktop.webp', 1280);
  await shrink('chat-mobile.jpg', 'showcase-phone.webp', 412);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
