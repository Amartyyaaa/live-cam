// Accounts in the browser: the sign-in screen (Google + email), the
// community-guidelines dialog and the avatar menu.

import { config, t } from './i18n.js';
import { $, $$, openDialog } from './ui.js';

const ERRORS = {
  invalid: 'auth.error.invalid',
  exists: 'auth.error.exists',
  weak: 'auth.error.weak',
  email: 'auth.error.email',
  name: 'auth.error.name',
  google: 'auth.error.google',
  rate_limited: 'error.rateLimited',
};

async function api(path, body) {
  try {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ...data };
  } catch {
    return { ok: false, error: 'generic' };
  }
}

export class Account extends EventTarget {
  /** @param {{ onBanned: (until: number) => void }} opts */
  constructor({ onBanned }) {
    super();
    this.onBanned = onBanned;
    this.user = null;
    this.waiting = null; // resolver of waitForSignIn()
    this.googleLoading = null;
    this.loaded = this.#load();
    this.#bindMenus();
    this.#bindAuthView();
  }

  get ready() {
    return !config.auth.required || Boolean(this.user?.guidelinesAccepted);
  }

  async #load() {
    const data = await api('/api/me');
    this.#setUser(data.user ?? null);
  }

  #setUser(user) {
    this.user = user;
    for (const el of $$('[data-signin]')) el.hidden = Boolean(user) || !config.auth.required;
    for (const box of $$('[data-account]')) {
      box.hidden = !user;
      if (!user) continue;
      const img = box.querySelector('.avatar-img');
      const initial = box.querySelector('.avatar-initial');
      img.hidden = !user.picture;
      if (user.picture) img.src = user.picture;
      initial.hidden = Boolean(user.picture);
      initial.textContent = Array.from(user.name || '?')[0].toUpperCase();
      box.querySelector('.account-name').textContent = user.name || '';
      box.querySelector('.account-email').textContent = user.email || '';
    }
    this.dispatchEvent(new Event('change'));
  }

  // -------------------------------------------------------------- sign in

  /** Called when the sign-in screen is shown; resolves with the user, or null if they leave. */
  waitForSignIn() {
    this.#prepareAuthView();
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  cancelSignIn() {
    this.waiting?.(null);
    this.waiting = null;
  }

  #signedIn(user) {
    this.#setUser(user);
    this.dispatchEvent(new CustomEvent('signedin', { detail: user }));
    this.waiting?.(user);
    this.waiting = null;
  }

  #showError(code) {
    const el = $('#auth-error');
    el.textContent = t(ERRORS[code] ?? 'auth.error.generic');
    el.hidden = false;
  }

  #prepareAuthView() {
    $('#auth-error').hidden = true;
    const { google, email } = config.auth;
    const emailBox = $('#email-auth');
    const more = $('#auth-more');
    if (google) {
      emailBox.hidden = true;
      more.hidden = !email;
      this.#renderGoogle();
    } else {
      emailBox.hidden = !email;
      more.hidden = true;
    }
  }

  #renderGoogle() {
    const slot = $('#google-slot');
    this.googleLoading ??= new Promise((resolve, reject) => {
      if (window.google?.accounts?.id) return resolve();
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
    this.googleLoading
      .then(() => {
        const gsi = window.google.accounts.id;
        gsi.initialize({
          client_id: config.auth.google,
          callback: (response) => this.#googleCredential(response.credential),
          ux_mode: 'popup',
          auto_select: false,
          itp_support: true,
        });
        slot.replaceChildren();
        gsi.renderButton(slot, {
          type: 'standard',
          theme: 'filled_black',
          size: 'large',
          shape: 'pill',
          text: 'continue_with',
          logo_alignment: 'left',
          locale: config.lang,
          width: Math.min(380, Math.max(240, slot.parentElement.clientWidth)),
        });
        slot.hidden = false;
      })
      .catch(() => {
        // Blocked by the network or an extension: fall back to email.
        this.googleLoading = null;
        slot.hidden = true;
        $('#auth-more').hidden = true;
        $('#email-auth').hidden = !config.auth.email;
      });
  }

  async #googleCredential(credential) {
    const res = await api('/api/auth/google', { credential });
    if (res.user) return this.#signedIn(res.user);
    if (res.error === 'banned') return this.onBanned(res.until);
    this.#showError(res.error === 'rate_limited' ? 'rate_limited' : 'google');
  }

  #bindAuthView() {
    const form = $('#auth-form');
    const password = form.elements.password;
    const setTab = (tab) => {
      form.dataset.tab = tab;
      for (const button of $$('#email-auth [data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
      password.autocomplete = tab === 'signup' ? 'new-password' : 'current-password';
      $('#auth-error').hidden = true;
    };
    for (const button of $$('#email-auth [data-tab]')) button.addEventListener('click', () => setTab(button.dataset.tab));
    $('#auth-more').addEventListener('click', () => {
      $('#email-auth').hidden = false;
      $('#auth-more').hidden = true;
      form.elements.email.focus();
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const signup = form.dataset.tab === 'signup';
      const name = form.elements.name.value.trim();
      const email = form.elements.email.value.trim();
      const pass = password.value;
      if (signup && !name) return this.#showError('name');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return this.#showError('email');
      if (pass.length < 8) return this.#showError(signup ? 'weak' : 'invalid');
      const submit = form.querySelector('.auth-submit');
      submit.disabled = true;
      const res = await api(signup ? '/api/auth/signup' : '/api/auth/login', signup ? { name, email, password: pass } : { email, password: pass });
      submit.disabled = false;
      if (res.user) {
        form.reset();
        return this.#signedIn(res.user);
      }
      if (res.error === 'banned') return this.onBanned(res.until);
      this.#showError(res.error);
    });
  }

  // ----------------------------------------------------------- guidelines

  /** Shows the community guidelines; resolves true once accepted (saved to the account when signed in). */
  async askGuidelines() {
    const dialog = $('#dlg-guidelines');
    const form = $('#guide-form');
    const error = $('#guide-error');
    form.reset();
    error.hidden = true;
    $('#guide-intro').hidden = !this.user; // the intro line talks about signing in
    const onSubmit = (event) => {
      if (event.submitter?.value !== 'agree') return;
      if (!form.elements.age.checked || !form.elements.terms.checked) {
        event.preventDefault();
        error.hidden = false;
      }
    };
    form.addEventListener('submit', onSubmit);
    const choice = await openDialog(dialog);
    form.removeEventListener('submit', onSubmit);
    if (choice !== 'agree') return false;
    if (!this.user) return true; // sign-in turned off (REQUIRE_SIGN_IN=false): the caller remembers it locally
    const res = await api('/api/me/guidelines', { age: true, terms: true });
    if (!res.user) return false;
    this.#setUser(res.user);
    return true;
  }

  // ------------------------------------------------------------- avatar menu

  async signOut() {
    await api('/api/auth/logout', {});
    try {
      window.google?.accounts?.id?.disableAutoSelect();
    } catch {
      /* ignore */
    }
    this.#setUser(null);
    this.dispatchEvent(new Event('signedout'));
  }

  #bindMenus() {
    for (const box of $$('[data-account]')) {
      const button = box.querySelector('.avatar-btn');
      const menu = box.querySelector('.account-menu');
      const close = () => {
        menu.hidden = true;
        button.setAttribute('aria-expanded', 'false');
      };
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const open = menu.hidden;
        menu.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
      });
      document.addEventListener('click', (event) => {
        if (!box.contains(event.target)) close();
      });
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          close();
          button.focus();
        }
      });
      box.querySelector('[data-signout]').addEventListener('click', () => {
        close();
        this.signOut();
      });
    }
  }
}
