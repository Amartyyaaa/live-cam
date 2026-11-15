// Server-side rendering of the HTML pages in every supported language.
//
// Pages are rendered on the server (not swapped in by JavaScript) so visitors
// see their language instantly and search engines index every language
// (/es, /pt, /hi … with hreflang alternates).
//
// Template syntax (server/views/*.html):
//   {{t:some.key}}  translated + HTML-escaped string
//   {{h:some.key}}  same, with the *starred* words wrapped in <em> (highlights)
//   {{l:some.key}}  same, with {terms} {privacy} {guidelines} turned into links
//   {{NAME}}        HTML-escaped variable
//   {{{NAME}}}      raw HTML variable (only for markup we build here)

import fs from 'node:fs';
import path from 'node:path';

const RTL = new Set(['ar', 'fa', 'he', 'ur']);
const LANGUAGE_ORDER = ['en', 'es', 'pt', 'fr', 'de', 'ar', 'hi', 'id', 'tr', 'ru', 'ja', 'zh'];
export const INTEREST_IDS = [
  'music', 'gaming', 'movies', 'anime', 'travel', 'sports',
  'books', 'art', 'tech', 'food', 'memes', 'languages',
];
const DOCS = ['terms', 'privacy', 'guidelines'];

// The logo: two circles — you and a stranger — and the spark where they meet.
// Inline (not an <img>) so CSS can recolour and animate the parts.
export const LOGO_SVG =
  '<svg class="logo-mark" viewBox="0 0 64 40" aria-hidden="true" focusable="false">' +
  '<circle class="logo-a" cx="22" cy="20" r="18"/><circle class="logo-b" cx="42" cy="20" r="18"/>' +
  '<path class="logo-c" d="M32 5.03A18 18 0 0 1 32 34.97A18 18 0 0 1 32 5.03Z"/></svg>';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

// JSON that is safe to embed inside <script type="application/json">.
const safeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const TOKEN = /\{\{\{([A-Z0-9_]+)\}\}\}|\{\{([thl]):([\w.-]+)\}\}|\{\{([A-Z0-9_]+)\}\}/g;

function interpolate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

const highlight = (text) => escapeHtml(text).replace(/\*([^*]+)\*/g, '<em>$1</em>');
const plain = (text) => String(text).replace(/\*/g, '');

function fill(template, { t, vars = {}, raw = {} }) {
  const link = (href, key) => `<a href="${href}" target="_blank" rel="noopener">${escapeHtml(t(key))}</a>`;
  const legalLinks = () => ({
    terms: link('/terms', 'link.terms'),
    privacy: link('/privacy', 'link.privacy'),
    guidelines: link('/guidelines', 'link.guidelines'),
  });
  return template.replace(TOKEN, (_, rawKey, kind, key, varKey) => {
    if (rawKey) return raw[rawKey] ?? '';
    if (kind === 't') return escapeHtml(plain(t(key)));
    if (kind === 'h') return highlight(t(key));
    if (kind === 'l') return interpolate(escapeHtml(t(key)), legalLinks());
    return escapeHtml(vars[varKey] ?? '');
  });
}

// Cards in the "people" band: illustrated portraits saying hi in their language.
const PEOPLE = [
  { img: 1, doodle: 'hi', flag: 'BR', hello: 'Oi!', lang: 'pt' },
  { img: 2, doodle: 'crown', flag: 'JP', hello: 'やあ！', lang: 'ja' },
  { img: 3, doodle: 'heart', flag: 'NG', hello: 'Hello!', lang: 'en' },
  { img: 4, doodle: 'arrow', flag: 'IN', hello: 'नमस्ते', lang: 'hi' },
  { brand: true },
  { img: 5, doodle: 'sparkle', flag: 'FR', hello: 'Salut\u00a0!', lang: 'fr' },
  { img: 6, doodle: 'hi', flag: 'EG', hello: 'أهلاً', lang: 'ar' },
  { img: 7, doodle: 'crown', flag: 'MX', hello: '¡Hola!', lang: 'es' },
  { img: 8, doodle: 'heart', flag: 'KR', hello: '안녕!', lang: 'ko' },
];

// Hand-drawn style doodles (white strokes) layered on the portraits.
const DOODLES = {
  hi: '<svg viewBox="0 0 96 90"><path d="M12 42C10 20 30 8 52 10c22 2 36 16 34 34s-20 28-40 26L28 84l5-17C19 62 13 54 12 42Z"/><path d="M35 28v28M51 28v28M35 42h16M63 37v19M63 28v1"/></svg>',
  crown: '<svg viewBox="0 0 96 70"><path d="M14 52 18 18l16 18 14-26 14 26 16-18 4 34Z"/><path d="M14 62c22 6 46 6 68 0"/><path d="M18 14v1M48 6v1M78 14v1"/></svg>',
  heart: '<svg viewBox="0 0 90 80"><path d="M45 72C14 52 6 30 22 18c10-7 20-2 23 8 3-10 13-15 23-8 16 12 8 34-23 54Z"/><path d="M70 10l6-6M78 22l8-2"/></svg>',
  arrow: '<svg viewBox="0 0 96 90"><path d="M10 80C30 70 44 48 74 18"/><path d="M58 14l18 2-4 18"/></svg>',
  sparkle: '<svg viewBox="0 0 96 90"><path d="M48 10c3 18 9 24 26 27-17 3-23 9-26 27-3-18-9-24-26-27 17-3 23-9 26-27Z"/><path d="M80 62c1 6 3 8 9 9-6 1-8 3-9 9-1-6-3-8-9-9 6-1 8-3 9-9Z"/></svg>',
};

const BAND_FLAGS = [
  'US', 'BR', 'IN', 'ID', 'MX', 'TR', 'EG', 'NG', 'PH', 'FR', 'DE', 'JP', 'KR', 'VN', 'PK', 'ES',
  'IT', 'GB', 'CA', 'AR', 'CO', 'ZA', 'KE', 'SA', 'MA', 'TH', 'PL', 'AU', 'PE', 'BD', 'CL', 'NL',
  'SE', 'GH', 'MY', 'AE', 'PT', 'UA', 'NZ', 'IE', 'GR', 'CH', 'SG', 'LK', 'NP', 'ET', 'TZ', 'DZ',
];
const INTEREST_EMOJI = {
  music: '🎵', gaming: '🎮', movies: '🎬', anime: '🍥', travel: '✈️', sports: '⚽',
  books: '📚', art: '🎨', tech: '💻', food: '🍜', memes: '😂', languages: '🗣️',
};

export const flagEmoji = (code) => String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

export class Renderer {
  /**
   * @param {{ root: string, config: { appName: string, contactEmail: string, limits: any }, cache?: boolean }} opts
   */
  constructor({ root, config, cache = true }) {
    this.root = root;
    this.config = config;
    this.cache = cache;
    this.#load();
  }

  #load() {
    const localesDir = path.join(this.root, 'locales');
    const viewsDir = path.join(this.root, 'server', 'views');
    const read = (...p) => fs.readFileSync(path.join(viewsDir, ...p), 'utf8');

    const files = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'));
    const dicts = Object.fromEntries(
      files.map((f) => [path.basename(f, '.json'), JSON.parse(fs.readFileSync(path.join(localesDir, f), 'utf8'))]),
    );
    if (!dicts.en) throw new Error('locales/en.json is required');

    /** @type {Map<string, { code: string, name: string, dir: string, ogLocale: string, dict: Record<string, string> }>} */
    this.locales = new Map();
    const order = (code) => {
      const i = LANGUAGE_ORDER.indexOf(code);
      return i === -1 ? LANGUAGE_ORDER.length : i;
    };
    for (const code of Object.keys(dicts).sort((a, b) => order(a) - order(b) || a.localeCompare(b))) {
      const { _meta = {}, ...strings } = dicts[code];
      const { _meta: _ignored, ...english } = dicts.en;
      this.locales.set(code, {
        code,
        name: _meta.name || code,
        dir: RTL.has(code) ? 'rtl' : 'ltr',
        ogLocale: _meta.ogLocale || code,
        dict: { ...english, ...strings }, // English fills any missing key
      });
    }

    this.templates = {
      index: read('index.html'),
      doc: read('doc.html'),
      notFound: read('404.html'),
      docs: Object.fromEntries(DOCS.map((name) => [name, read('docs', `${name}.html`)])),
    };
  }

  #fresh() {
    if (!this.cache) this.#load();
  }

  get languages() {
    return [...this.locales.values()];
  }

  has(code) {
    return this.locales.has(code);
  }

  homePath(code) {
    return code === 'en' ? '/' : `/${code}`;
  }

  /** Picks the best supported language from an Accept-Language header. */
  negotiate(header) {
    if (!header || typeof header !== 'string') return null;
    const ranked = header
      .split(',')
      .slice(0, 20)
      .map((part, index) => {
        const [tag, ...params] = part.trim().split(';');
        const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)).find(Boolean);
        return { tag: tag.trim().toLowerCase(), q: q ? Number(q[1]) : 1, index };
      })
      .filter((x) => x.tag && x.q > 0)
      .sort((a, b) => b.q - a.q || a.index - b.index);
    for (const { tag } of ranked) {
      const base = tag.split('-')[0];
      // Only Simplified Chinese is available — don't push it on zh-TW/zh-HK readers.
      if (base === 'zh' && /^zh-(tw|hk|mo|hant)/.test(tag)) continue;
      if (this.locales.has(base)) return base;
    }
    return null;
  }

  translator(code) {
    const locale = this.locales.get(code) ?? this.locales.get('en');
    const base = { app: this.config.appName };
    return (key, vars = {}) => interpolate(locale.dict[key] ?? key, { ...base, ...vars });
  }

  #shared(code, origin) {
    const locale = this.locales.get(code) ?? this.locales.get('en');
    const t = this.translator(locale.code);
    const year = new Date().getFullYear();
    const vars = {
      LANG: locale.code,
      DIR: locale.dir,
      APP_NAME: this.config.appName,
      CONTACT_EMAIL: this.config.contactEmail,
      ORIGIN: origin,
      YEAR: year,
      HOME_URL: this.homePath(locale.code),
      LANG_NAME: locale.name,
      OG_LOCALE: locale.ogLocale,
    };
    return { locale, t, vars };
  }

  renderIndex({ lang, origin }) {
    this.#fresh();
    const { locale, t, vars } = this.#shared(lang, origin);
    const hreflang = [
      ...this.languages.map(
        (l) => `<link rel="alternate" hreflang="${l.code}" href="${escapeHtml(origin + this.homePath(l.code))}">`,
      ),
      `<link rel="alternate" hreflang="x-default" href="${escapeHtml(origin + '/')}">`,
    ].join('\n  ');

    const langLinks = this.languages
      .map(
        (l) =>
          `<li><a href="${this.homePath(l.code)}" hreflang="${l.code}" lang="${l.code}" data-lang="${l.code}"` +
          `${l.code === locale.code ? ' aria-current="true"' : ''}>${escapeHtml(l.name)}</a></li>`,
      )
      .join('');

    const interestChips = INTEREST_IDS.map(
      (id) => `<button type="button" class="chip chip-suggest" data-interest="${id}">${escapeHtml(t(`interest.${id}`))}</button>`,
    ).join('');

    const clientConfig = {
      appName: this.config.appName,
      lang: locale.code,
      dir: locale.dir,
      homeUrl: this.homePath(locale.code),
      maxInterests: this.config.limits.maxInterests,
      maxInterestLength: this.config.limits.maxInterestLength,
      maxMessageLength: this.config.limits.maxMessageLength,
      interestIds: INTEREST_IDS,
      auth: {
        required: this.config.auth.required,
        google: this.config.auth.googleClientId || null,
        email: this.config.auth.allowEmail,
      },
    };

    const card = (person, hidden) => {
      if (person.brand) {
        return (
          `<div class="person-card brand-card">${LOGO_SVG}<span class="brand-card-name">${escapeHtml(this.config.appName)}</span>` +
          `<button type="button" class="btn btn-black" data-start="video"${hidden ? ' tabindex="-1"' : ''}>${escapeHtml(plain(t('cards.cta')))}</button></div>`
        );
      }
      return (
        `<div class="person-card"><img src="/img/people/${person.img}.webp" alt="" width="320" height="400" loading="lazy" decoding="async">` +
        `<span class="doodle doodle-${person.doodle}">${DOODLES[person.doodle]}</span>` +
        `<span class="hello-chip"><span class="flag">${flagEmoji(person.flag)}</span><span lang="${person.lang}" dir="auto">${person.hello}</span></span></div>`
      );
    };
    const peopleCards =
      PEOPLE.map((p) => card(p, false)).join('') +
      `<div class="marquee-copy" aria-hidden="true">${PEOPLE.map((p) => card(p, true)).join('')}</div>`;

    const flags = (list) => {
      const items = list.map((code) => `<span class="flag-chip"><span class="flag">${flagEmoji(code)}</span></span>`).join('');
      return `${items}<span class="marquee-copy" aria-hidden="true">${items}</span>`;
    };
    const half = Math.ceil(BAND_FLAGS.length / 2);
    const interestPills = INTEREST_IDS.map(
      (id) => `<li class="interest-pill"><span aria-hidden="true">${INTEREST_EMOJI[id]}</span>${escapeHtml(t(`interest.${id}`))}</li>`,
    ).join('');

    return fill(this.templates.index, {
      t,
      vars: { ...vars, CANONICAL: origin + this.homePath(locale.code) },
      raw: {
        LOGO: LOGO_SVG,
        HREFLANG: hreflang,
        LANG_LINKS: langLinks,
        INTEREST_CHIPS: interestChips,
        PEOPLE_CARDS: peopleCards,
        INTEREST_PILLS: interestPills,
        FLAGS_A: flags(BAND_FLAGS.slice(0, half)),
        FLAGS_B: flags(BAND_FLAGS.slice(half)),
        I18N_JSON: safeJson(locale.dict),
        CONFIG_JSON: safeJson(clientConfig),
      },
    });
  }

  renderDoc(name, { origin }) {
    this.#fresh();
    if (!this.templates.docs[name]) return null;
    const { t, vars } = this.#shared('en', origin);
    const content = fill(this.templates.docs[name].replace(/<!--[\s\S]*?-->\s*/g, ''), { t, vars });
    const title = /<h1[^>]*>([^<]*)<\/h1>/.exec(content)?.[1] ?? this.config.appName;
    return fill(this.templates.doc, {
      t,
      vars: { ...vars, TITLE: title, CANONICAL: `${origin}/${name}` },
      raw: { CONTENT: content, LOGO: LOGO_SVG },
    });
  }

  renderNotFound({ origin }) {
    this.#fresh();
    const { t, vars } = this.#shared('en', origin);
    return fill(this.templates.notFound, { t, vars, raw: { LOGO: LOGO_SVG } });
  }

  manifest(lang) {
    const { locale, t } = this.#shared(lang, '');
    return JSON.stringify(
      {
        name: `${this.config.appName} — ${t('hero.eyebrow')}`,
        short_name: this.config.appName,
        description: t('meta.description'),
        lang: locale.code,
        dir: locale.dir,
        start_url: this.homePath(locale.code),
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#FFF6EE',
        theme_color: '#FF5B2E',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      null,
      2,
    );
  }

  sitemap(origin) {
    const alternates = this.languages
      .map((l) => `<xhtml:link rel="alternate" hreflang="${l.code}" href="${escapeHtml(origin + this.homePath(l.code))}"/>`)
      .join('');
    const urls = [
      ...this.languages.map((l) => `<url><loc>${escapeHtml(origin + this.homePath(l.code))}</loc>${alternates}</url>`),
      ...DOCS.map((name) => `<url><loc>${escapeHtml(`${origin}/${name}`)}</loc></url>`),
    ];
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
      urls.join('\n') +
      '\n</urlset>\n'
    );
  }
}
