// Translations come pre-rendered from the server: the page's language
// dictionary is embedded as JSON, so there is no extra request or flash of
// untranslated text. Everything else (countries, numbers, lists, dates) uses
// the browser's built-in Intl APIs, which know every language on Earth.

const readJson = (id) => {
  try {
    return JSON.parse(document.getElementById(id)?.textContent || '{}');
  } catch {
    return {};
  }
};

const strings = readJson('i18n-data');
export const config = readJson('app-config');
export const lang = config.lang || document.documentElement.lang || 'en';

export function t(key, vars = {}) {
  const template = strings[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    if (name in vars) return String(vars[name]);
    if (name === 'app') return config.appName;
    return match;
  });
}

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

const regionNames = safe(() => new Intl.DisplayNames([lang], { type: 'region' }), null);
const numberFormat = safe(() => new Intl.NumberFormat(lang), null);
const listFormat = safe(() => new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' }), null);
const dateFormat = safe(() => new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }), null);

export const countryName = (code) => (code ? safe(() => regionNames?.of(code), null) ?? code : '');
export const formatNumber = (n) => numberFormat?.format(n) ?? String(n);
export const formatList = (items) => listFormat?.format(items) ?? items.join(', ');
export const formatDateTime = (ms) => dateFormat?.format(new Date(ms)) ?? new Date(ms).toLocaleString();

/** "BR" -> 🇧🇷 (regional indicator symbols). */
export function flagEmoji(code) {
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return '🌐';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// ---------------------------------------------------------------- interests
// Suggested interests have language-neutral ids ("music") with a translated
// label ("Música"), so a Spanish and a Japanese speaker who both pick "Music"
// still match. Typing the translated word maps to the same id.

const maxTagLength = config.maxInterestLength || 24;
export function normalizeTag(text) {
  return Array.from(
    String(text)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[#,;\n]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, maxTagLength)
    .join('')
    .trim();
}

const interestLabels = new Map((config.interestIds || []).map((id) => [id, t(`interest.${id}`)]));
const labelToId = new Map([...interestLabels].map(([id, label]) => [normalizeTag(label), id]));

export const interestLabel = (tag) => interestLabels.get(tag) ?? tag;
export function canonicalInterest(text) {
  const tag = normalizeTag(text);
  return labelToId.get(tag) ?? tag;
}
