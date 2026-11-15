// The lobby: your camera preview + options, and a Start button. Nothing is
// matched until the person presses Start.

import { canonicalInterest, config, interestLabel, t } from './i18n.js';
import { mediaErrorKind, mediaSupported } from './media.js';
import { prefs } from './prefs.js';
import { $, $$, openDialog } from './ui.js';

export class Lobby {
  /**
   * @param {{ camera: import('./camera.js').Camera, account: import('./account.js').Account,
   *           onStart: (opts: { mode: string, interests: string[], langOnly: boolean }) => void,
   *           onLeave: () => void }} deps
   */
  constructor({ camera, account, onStart, onLeave }) {
    this.camera = camera;
    this.account = account;
    this.onStart = onStart;
    this.onLeave = onLeave;
    this.mode = prefs.get('mode', 'video') === 'text' ? 'text' : 'video';
    this.visible = false;
    this.card = $('#lobby-card');
    this.video = $('#lobby-video');
    this.#bindInterests();
    this.#bindControls();
    camera.addEventListener('change', () => this.#renderPreview());
  }

  show({ mode } = {}) {
    this.visible = true;
    if (mode) this.mode = mode;
    const name = this.account.user?.name;
    $('#lobby-hello').textContent = name ? t('lobby.hello', { name }) : t('self.label');
    this.#applyMode();
  }

  hide() {
    this.visible = false;
    this.video.srcObject = null;
  }

  #applyMode() {
    prefs.set('mode', this.mode);
    this.card.dataset.mode = this.mode;
    for (const seg of $$('.segment', this.card)) seg.setAttribute('aria-checked', String(seg.dataset.mode === this.mode));
    if (this.mode === 'video') this.#startPreview();
    else {
      this.camera.stop(); // privacy: no camera in text mode
      this.card.dataset.media = 'none';
    }
  }

  #renderPreview() {
    if (!this.visible) return;
    const live = this.camera.live;
    if (this.video.srcObject !== this.camera.stream) this.video.srcObject = live ? this.camera.stream : null;
    this.video.classList.toggle('mirrored', this.camera.facing !== 'environment');
    if (live) this.card.dataset.media = 'ready';
  }

  async #startPreview() {
    if (this.camera.live) return this.#renderPreview();
    const problem = !mediaSupported ? 'unsupported' : !window.isSecureContext ? 'insecure' : null;
    if (!problem) {
      this.card.dataset.media = 'pending';
      try {
        const stream = await this.camera.open();
        if (stream) this.#renderPreview();
        return;
      } catch (err) {
        return this.#mediaProblem(mediaErrorKind(err));
      }
    }
    return this.#mediaProblem(problem);
  }

  async #mediaProblem(kind) {
    this.card.dataset.media = 'error';
    if (!this.visible) return;
    const copy = {
      denied: [t('media.denied.title'), t('media.denied.text')],
      notFound: [t('media.notFound'), ''],
      inUse: [t('media.inUse'), ''],
      unsupported: [t('error.unsupported'), ''],
      insecure: [t('error.insecure'), ''],
    }[kind] ?? [t('media.denied.title'), t('media.denied.text')];
    $('#media-error-title').textContent = copy[0];
    $('#media-error-text').textContent = copy[1];
    $('#media-error-text').hidden = !copy[1];
    $('#media-retry').hidden = kind === 'unsupported' || kind === 'insecure';
    const choice = await openDialog($('#dlg-media'));
    if (!this.visible) return;
    if (choice === 'retry') return this.#startPreview();
    if (choice === 'text') {
      this.mode = 'text';
      return this.#applyMode();
    }
    if (choice === 'home') this.onLeave();
  }

  #bindControls() {
    for (const seg of $$('.segment', this.card)) {
      seg.addEventListener('click', () => {
        if (this.mode === seg.dataset.mode) return;
        this.mode = seg.dataset.mode;
        this.#applyMode();
      });
    }
    $('#lobby-start').addEventListener('click', async () => {
      this.#flushInput();
      if (this.mode === 'video' && !this.camera.live) {
        await this.#startPreview();
        if (!this.camera.live) return;
      }
      this.onStart({ mode: this.mode, interests: [...this.tags], langOnly: $('#same-language').checked });
    });
  }

  // ------------------------------------------------------------ interests

  #bindInterests() {
    const input = $('#interest-input');
    const list = $('#tag-list');
    const box = $('#tag-input');
    const sameLanguage = $('#same-language');
    const max = config.maxInterests || 10;
    this.tags = (prefs.get('interests', []) || []).filter((x) => typeof x === 'string' && x).slice(0, max);
    sameLanguage.checked = prefs.get('langOnly', false) === true;
    sameLanguage.addEventListener('change', () => prefs.set('langOnly', sameLanguage.checked));

    const save = () => prefs.set('interests', this.tags);
    const render = () => {
      list.replaceChildren(
        ...this.tags.map((tag, index) => {
          const li = document.createElement('li');
          li.className = 'tag';
          const label = document.createElement('span');
          label.textContent = interestLabel(tag);
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.setAttribute('aria-label', t('interests.remove', { tag: interestLabel(tag) }));
          remove.innerHTML = `<svg class="icon" aria-hidden="true"><use href="${config.icons}#i-x"/></svg>`;
          remove.addEventListener('click', () => {
            this.tags.splice(index, 1);
            save();
            render();
            input.focus();
          });
          li.append(label, remove);
          return li;
        }),
      );
      for (const chip of $$('.chip-suggest')) chip.setAttribute('aria-pressed', String(this.tags.includes(chip.dataset.interest)));
      input.placeholder = this.tags.length >= max ? '' : t('interests.placeholder');
    };
    const add = (raw) => {
      const tag = canonicalInterest(raw);
      if (!tag || this.tags.includes(tag) || this.tags.length >= max) return;
      this.tags.push(tag);
      save();
      render();
    };
    this.#flushInput = () => {
      if (!input.value.trim()) return;
      for (const part of input.value.split(/[,;]/)) add(part);
      input.value = '';
    };

    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return; // IME still composing (Japanese, Chinese…)
      if (event.key === 'Enter' || event.key === ',') {
        event.preventDefault();
        this.#flushInput();
      } else if (event.key === 'Backspace' && !input.value && this.tags.length) {
        this.tags.pop();
        save();
        render();
      }
    });
    input.addEventListener('blur', () => this.#flushInput());
    box.addEventListener('click', (event) => {
      if (event.target === box) input.focus();
    });
    for (const chip of $$('.chip-suggest')) {
      chip.addEventListener('click', () => {
        const index = this.tags.indexOf(chip.dataset.interest);
        if (index >= 0) {
          this.tags.splice(index, 1);
          save();
          render();
        } else add(chip.dataset.interest);
      });
    }
    render();
  }

  #flushInput = () => {};
}
