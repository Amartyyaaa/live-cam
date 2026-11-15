// Server-side rendering of the HTML pages in every supported language.
//
// Pages are rendered on the server (not swapped in by JavaScript) so visitors
// see their language instantly and search engines index every language
// (/es, /pt, /hi … with hreflang alternates).
//
// Template syntax (server/views/*.html):
//   {{t:some.key}}  translated + HTML-escaped string
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

const TOKEN = /\{\{\{([A-Z0-9_]+)\}\}\}|\{\{t:([\w.-]+)\}\}|\{\{([A-Z0-9_]+)\}\}/g;

function fill(template, { t, vars = {}, raw = {} }) {
  return template.replace(TOKEN, (_, rawKey, tKey, varKey) => {
    if (rawKey) return raw[rawKey] ?? '';
    if (tKey) return escapeHtml(t(tKey));
    return escapeHtml(vars[varKey] ?? '');
  });
}

function interpolate(str, vars) {
  return str.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

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
    const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
    const consent = interpolate(escapeHtml(t('consent')), {
      terms: link('/terms', t('link.terms')),
      guidelines: link('/guidelines', t('link.guidelines')),
    });

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
    };

    // "Say hi to the *world*." -> highlight the starred word.
    const heroTitle = escapeHtml(t('hero.title')).replace(/\*([^*]+)\*/, '<em>$1</em>');

    return fill(this.templates.index, {
      t,
      vars: { ...vars, CANONICAL: origin + this.homePath(locale.code) },
      raw: {
        LOGO: LOGO_SVG,
        HERO_TITLE: heroTitle,
        HREFLANG: hreflang,
        LANG_LINKS: langLinks,
        CONSENT_HTML: consent,
        INTEREST_CHIPS: interestChips,
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
