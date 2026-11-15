// Landing intro: words in dozens of languages drift around, then fly together
// to spell the app's name in a word cloud — then the headline appears.

const WORDS = [
  // greetings
  'Hello', 'Hi', 'Hey', 'Hola', 'Olá', 'Oi', 'Bonjour', 'Salut', 'Ciao', 'Hallo', 'Hej', 'Hoi', 'Cześć', 'Merhaba',
  'Selam', 'Halo', 'Kumusta', 'Xin chào', 'Jambo', 'Habari', 'Sawubona', 'Aloha', 'Namaste', 'Привет', 'Здравствуйте',
  'Γεια σου', 'مرحبا', 'أهلاً', 'سلام', 'שלום', 'नमस्ते', 'নমস্কার', 'வணக்கம்', 'สวัสดี', '你好', '嗨', 'こんにちは', 'やあ',
  '안녕', '안녕하세요', 'ሰላም', 'Bawo', 'Sannu', 'Salve',
  // friends & world
  'friends', 'amigos', 'amis', 'Freunde', 'amici', 'arkadaş', 'teman', 'kaibigan', 'rafiki', 'друзья', 'أصدقاء', 'दोस्त',
  '朋友', '友達', '친구', 'bạn bè', 'world', 'mundo', 'monde', 'Welt', 'dünya', 'dunia', 'мир', 'عالم', 'दुनिया', '世界', '세계',
  // vibes
  'CHAT', 'MEET', 'SMILE', 'LAUGH', 'TOGETHER', 'CURIOUS', 'SPONTANEOUS', 'VIBES', 'MUSIC', 'TRAVEL', 'ANIME', 'GAMING',
  'STORIES', 'PEOPLE', 'STRANGERS', 'CONNECT', 'SAY HI', 'NEW', 'NOW', 'REAL', 'LIVE', 'JOY', 'WAVE', 'FUN', 'CHILL',
  'charlar', 'conversa', 'discuter', 'plaudern', 'sohbet', 'ngobrol', 'общение', 'دردشة', 'बातचीत', '聊天', 'おしゃべり', '대화',
];

// One colour family per letter: orange, pink, violet, sun, mint, sky.
const PALETTE = [
  ['#ff7a45', '#ff5b2e', '#ffb088', '#ff9466'],
  ['#ff4f8b', '#ff2e7a', '#ff9ec2', '#ff77a8'],
  ['#9b7bff', '#7c5cff', '#c3b2ff', '#b19bff'],
  ['#ffc23d', '#ffb21e', '#ffe08a', '#ffd166'],
  ['#3ddc97', '#12b76a', '#9af0c9', '#6ee7b7'],
  ['#4fb3ff', '#2e8bff', '#a8d8ff', '#7cc4ff'],
];

const FONT_STACK = "'Bricolage Grotesque', system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', sans-serif";
const FLOAT_MS = 1100;
const FLY_MS = 1500;
const FLY_STAGGER_MS = 700;
const SETTLE_MS = 450;

const random = (min, max) => min + Math.random() * (max - min);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export async function playIntro(canvas, { text, onFormed } = {}) {
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let width = 0;
  let height = 0;
  let particles = [];
  let formedLayer = null;
  let raf = 0;
  let startedAt = 0;
  let done = false;

  try {
    await document.fonts?.load(`800 100px 'Bricolage Grotesque'`);
  } catch {
    /* fall back to system fonts */
  }

  function layout() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build(dpr);
  }

  /** Vertical space (canvas coordinates) not covered by the header or the headline. */
  function freeBand() {
    const rect = canvas.getBoundingClientRect();
    const header = document.querySelector('.site-header');
    const copy = canvas.parentElement?.querySelector('.intro-copy');
    const top = header ? Math.max(0, header.getBoundingClientRect().bottom - rect.top) : 0;
    const bottom = copy ? copy.getBoundingClientRect().top - rect.top : height * 0.6;
    return bottom - top >= 120 ? { top, bottom } : { top: 0, bottom: height * 0.6 };
  }

  // Letter mask: each letter drawn in its own "colour" so we know which letter a pixel belongs to.
  function build(dpr) {
    const letters = [...String(text || 'HIYO').toUpperCase()].slice(0, 10);
    const mask = document.createElement('canvas');
    mask.width = Math.ceil(width);
    mask.height = Math.ceil(height);
    const m = mask.getContext('2d', { willReadFrequently: true });
    // Letters sit in the free band between the header and the headline below them.
    const band = freeBand();
    let size = Math.min(height * 0.42, width * 0.4, (band.bottom - band.top) * 1.2);
    const measure = () => {
      m.font = `800 ${size}px ${FONT_STACK}`;
      return letters.reduce((sum, ch) => sum + m.measureText(ch).width, 0) + size * 0.04 * (letters.length - 1);
    };
    let total = measure();
    if (total > width * 0.94) {
      size *= (width * 0.94) / total;
      total = measure();
    }
    // Cap height is ~0.62em, so this centres the letters in the band.
    const baseline = (band.top + band.bottom) / 2 + size * 0.31;
    let x = (width - total) / 2;
    m.textBaseline = 'alphabetic';
    letters.forEach((ch, i) => {
      m.fillStyle = `rgb(${i + 1},0,0)`;
      m.fillText(ch, x, baseline);
      x += m.measureText(ch).width + size * 0.04;
    });
    const data = m.getImageData(0, 0, mask.width, mask.height).data;
    const letterAt = (px, py) => {
      const ix = Math.round(px);
      const iy = Math.round(py);
      if (ix < 0 || iy < 0 || ix >= mask.width || iy >= mask.height) return 0;
      return data[(iy * mask.width + ix) * 4];
    };

    // Fill the letters row by row with words (a dense word cloud).
    const base = Math.max(7, Math.min(15, size / 15));
    const list = [];
    for (let y = baseline - size * 0.8; y < baseline + size * 0.05; y += base * 1.02) {
      let cursor = (width - total) / 2 - random(0, base * 4);
      while (cursor < (width + total) / 2) {
        const word = pick(WORDS);
        const scale = Math.random() < 0.08 ? 1.7 : Math.random() < 0.3 ? 1.25 : 1;
        const fontSize = base * scale;
        ctx.font = `700 ${fontSize}px ${FONT_STACK}`;
        const w = ctx.measureText(word).width;
        const cy = y - fontSize * 0.35;
        const hit = letterAt(cursor + w / 2, cy) || letterAt(cursor + 2, cy) || letterAt(cursor + w - 2, cy);
        if (hit) {
          const shades = PALETTE[(hit - 1) % PALETTE.length];
          list.push({
            word,
            fontSize,
            color: pick(shades),
            tx: cursor,
            ty: y,
            x: random(-0.05, 1.0) * width,
            y: random(0.02, 1.0) * height,
            vx: random(-14, 14),
            vy: random(-8, 8),
            depth: random(0.25, 0.95),
            delay: random(0, FLY_STAGGER_MS),
          });
        }
        cursor += w + base * 0.4;
      }
    }
    particles = list;

    // The final frame, clipped to the letters so their edges are crisp.
    formedLayer = document.createElement('canvas');
    formedLayer.width = canvas.width;
    formedLayer.height = canvas.height;
    const f = formedLayer.getContext('2d');
    f.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const p of particles) {
      f.font = `700 ${p.fontSize}px ${FONT_STACK}`;
      f.fillStyle = p.color;
      f.fillText(p.word, p.tx, p.ty);
    }
    f.globalCompositeOperation = 'destination-in';
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.drawImage(mask, 0, 0, mask.width, mask.height, 0, 0, formedLayer.width, formedLayer.height);
    // a faint fill underneath the words keeps the letters readable
    f.globalCompositeOperation = 'destination-over';
    f.globalAlpha = 0.1;
    f.setTransform(dpr, 0, 0, dpr, 0, 0);
    x = (width - total) / 2;
    letters.forEach((ch, i) => {
      f.font = `800 ${size}px ${FONT_STACK}`;
      f.fillStyle = PALETTE[i % PALETTE.length][1];
      f.fillText(ch, x, baseline);
      x += f.measureText(ch).width + size * 0.04;
    });
    f.globalAlpha = 1;
    f.globalCompositeOperation = 'source-over';
  }

  function drawFinal(alpha = 1) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(formedLayer, 0, 0);
    ctx.restore();
  }

  function frame(now) {
    if (!startedAt) startedAt = now;
    const elapsed = now - startedAt;
    ctx.clearRect(0, 0, width, height);
    const flyStart = FLOAT_MS;
    const flyEnd = FLOAT_MS + FLY_STAGGER_MS + FLY_MS;
    const settle = Math.min(1, Math.max(0, (elapsed - flyEnd + SETTLE_MS) / SETTLE_MS));

    ctx.textBaseline = 'alphabetic';
    for (const p of particles) {
      const t = Math.min(1, Math.max(0, (elapsed - flyStart - p.delay) / FLY_MS));
      const e = easeInOut(t);
      const driftX = p.x + (p.vx * Math.min(elapsed, flyStart + p.delay)) / 1000;
      const driftY = p.y + (p.vy * Math.min(elapsed, flyStart + p.delay)) / 1000;
      const x = driftX + (p.tx - driftX) * e;
      const y = driftY + (p.ty - driftY) * e;
      const fadeIn = Math.min(1, elapsed / 500);
      ctx.globalAlpha = fadeIn * (p.depth + (1 - p.depth) * e) * (1 - settle);
      ctx.font = `700 ${p.fontSize}px ${FONT_STACK}`;
      ctx.fillStyle = p.color;
      ctx.fillText(p.word, x, y);
    }
    ctx.globalAlpha = 1;
    if (settle > 0) drawFinal(settle);

    if (elapsed < flyEnd + SETTLE_MS) {
      raf = requestAnimationFrame(frame);
    } else {
      finish();
    }
  }

  function finish() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    ctx.clearRect(0, 0, width, height);
    drawFinal(1);
    onFormed?.();
  }

  layout();
  if (reduced || particles.length === 0) {
    finish();
  } else {
    raf = requestAnimationFrame(frame);
  }

  // Re-layout on resize (jumping straight to the finished word cloud).
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const rect = canvas.getBoundingClientRect();
      if (Math.abs(rect.width - width) < 2 && Math.abs(rect.height - height) < 2) return;
      layout();
      done = false;
      finish();
    }, 200);
  };
  window.addEventListener('resize', onResize);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
  };
}
