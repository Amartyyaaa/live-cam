// Landing page: interests, language filter, consent and the start buttons.

import { canonicalInterest, config, interestLabel, t } from './i18n.js';
import { prefs } from './prefs.js';
import { $, $$ } from './ui.js';

const CONSENT_VERSION = 1;

export function initHome({ onStart }) {
  const form = $('#start-form');
  const input = $('#interest-input');
  const list = $('#tag-list');
  const tagBox = $('#tag-input');
  const sameLanguage = $('#same-language');
  const consent = $('#consent');
  const consentRow = $('#consent-row');
  const error = $('#start-error');
  const max = config.maxInterests || 10;

  let tags = (prefs.get('interests', []) || []).filter((x) => typeof x === 'string' && x).slice(0, max);
  sameLanguage.checked = prefs.get('langOnly', false) === true;
  consent.checked = prefs.get('consent', 0) === CONSENT_VERSION;

  function save() {
    prefs.set('interests', tags);
  }

  function render() {
    list.replaceChildren(
      ...tags.map((tag, index) => {
        const li = document.createElement('li');
        li.className = 'tag';
        const label = document.createElement('span');
        label.textContent = interestLabel(tag);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.setAttribute('aria-label', t('interests.remove', { tag: interestLabel(tag) }));
        remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="/icons.svg#i-x"/></svg>';
        remove.addEventListener('click', () => {
          removeAt(index);
          input.focus();
        });
        li.append(label, remove);
        return li;
      }),
    );
    for (const chip of $$('.chip-suggest')) {
      chip.setAttribute('aria-pressed', String(tags.includes(chip.dataset.interest)));
    }
    input.placeholder = tags.length >= max ? '' : t('interests.placeholder');
  }

  function add(raw) {
    const tag = canonicalInterest(raw);
    if (!tag || tags.includes(tag) || tags.length >= max) return false;
    tags.push(tag);
    save();
    render();
    return true;
  }

  function removeAt(index) {
    tags.splice(index, 1);
    save();
    render();
  }

  function addFromInput() {
    const value = input.value;
    if (!value.trim()) return;
    for (const part of value.split(/[,;]/)) add(part);
    input.value = '';
  }

  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return; // IME (Japanese, Chinese…) still composing
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addFromInput();
    } else if (event.key === 'Backspace' && !input.value && tags.length) {
      removeAt(tags.length - 1);
    }
  });
  input.addEventListener('blur', addFromInput);
  tagBox.addEventListener('click', (event) => {
    if (event.target === tagBox) input.focus();
  });

  for (const chip of $$('.chip-suggest')) {
    chip.addEventListener('click', () => {
      const id = chip.dataset.interest;
      const index = tags.indexOf(id);
      if (index >= 0) removeAt(index);
      else add(id);
    });
  }

  sameLanguage.addEventListener('change', () => prefs.set('langOnly', sameLanguage.checked));
  consent.addEventListener('change', () => {
    prefs.set('consent', consent.checked ? CONSENT_VERSION : 0);
    if (consent.checked) error.hidden = true;
  });

  function start(mode) {
    addFromInput();
    if (!consent.checked) {
      error.hidden = false;
      consentRow.classList.remove('shake');
      void consentRow.offsetWidth; // restart the animation
      consentRow.classList.add('shake');
      consent.focus();
      return;
    }
    onStart({ mode, interests: [...tags], langOnly: sameLanguage.checked });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    start('video');
  });
  $('#start-text').addEventListener('click', () => start('text'));

  // Language picker: remember an explicit choice (used by "/" to redirect).
  const picker = $('#lang-picker');
  for (const link of $$('.lang-menu a', picker)) {
    link.addEventListener('click', () => {
      document.cookie = `lang=${link.dataset.lang}; path=/; max-age=31536000; samesite=lax`;
    });
  }
  document.addEventListener('click', (event) => {
    if (picker.open && !picker.contains(event.target)) picker.open = false;
  });
  picker.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && picker.open) {
      picker.open = false;
      picker.querySelector('summary').focus();
    }
  });

  render();
}
