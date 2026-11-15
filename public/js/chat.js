// The chat room. Opened from the lobby, it starts searching straight away;
// "Stop" goes back to the lobby.
//
// States (mirrored on #chat-layout[data-state] so CSS can react):
//   idle        nothing happening (e.g. after a reconnect); "Start" button
//   searching   waiting in the queue
//   connecting  matched, WebRTC handshake in progress (video mode)
//   connected   chatting
//   ended       the stranger left; auto-next kicks in unless disabled

import { config, countryName, flagEmoji, formatList, interestLabel, t } from './i18n.js';
import { listDevices } from './media.js';
import { request } from './net.js';
import { Peer } from './peer.js';
import { prefs } from './prefs.js';
import { $, openDialog, reducedMotion, toast } from './ui.js';

const CONNECT_TIMEOUT_MS = 15_000;
const AUTO_NEXT_DELAY_MS = 1_200;
const SEARCH_TIP_AFTER_MS = 15_000;
const LAST_PARTNER_REPORT_MS = 110_000; // server accepts reports up to 2 min after a chat
const MAX_MESSAGES = 150;
const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const RADAR_COUNTRIES = 'BR IN US ID MX TR EG NG PH FR DE JP KR VN PK ES IT GB CA AR CO ZA KE SA MA TH PL AU PE BD'.split(' ');

const finePointer = () => window.matchMedia?.('(pointer: fine)').matches ?? true;
const coarsePointer = () => window.matchMedia?.('(pointer: coarse)').matches ?? false;

export class Chat {
  /**
   * @param {{ socket: import('socket.io-client').Socket, camera: import('./camera.js').Camera,
   *           onLeave: () => void, onAuthNeeded: () => void }} opts
   */
  constructor({ socket, camera, onLeave, onAuthNeeded }) {
    this.socket = socket;
    this.camera = camera;
    this.onLeave = onLeave;
    this.onAuthNeeded = onAuthNeeded;
    this.state = 'idle';
    this.mode = 'video';
    this.search = { interests: [], langOnly: false };
    this.peer = null;
    this.pairId = null;
    this.partner = null;
    this.lastPairId = null;
    this.lastPairAt = 0;
    this.hello = null;
    this.blurred = false;
    this.typingSent = false;
    this.resumeOnReconnect = false;
    this.timers = {};
    this.baseTitle = null;

    const id = (x) => document.getElementById(x);
    this.el = {
      layout: id('chat-layout'),
      tileRemote: id('tile-remote'),
      remoteVideo: id('remote-video'),
      localVideo: id('local-video'),
      remoteCamOff: id('remote-camoff'),
      localCamOff: id('local-camoff'),
      revealBtn: id('reveal-btn'),
      partnerChip: id('partner-chip'),
      partnerFlag: id('partner-flag'),
      partnerCountry: id('partner-country'),
      partnerMuted: id('partner-muted'),
      panelFlag: id('panel-flag'),
      panelCountry: id('panel-country'),
      reportBtn: id('report-btn'),
      swipeHint: id('swipe-hint'),
      searchTip: id('search-tip'),
      radarFlags: id('radar-flags'),
      messages: id('messages'),
      typing: id('typing'),
      quickReplies: id('quick-replies'),
      composer: id('composer'),
      input: id('message-input'),
      sendBtn: id('send-btn'),
      stopBtn: id('stop-btn'),
      nextBtn: id('next-btn'),
      flipBtn: id('flip-btn'),
      settingsBtn: id('settings-btn'),
      dlgReport: id('dlg-report'),
      reportForm: id('report-form'),
      dlgSettings: id('dlg-settings'),
      deviceFields: id('device-fields'),
      cameraSelect: id('camera-select'),
      micSelect: id('mic-select'),
      blurToggle: id('blur-toggle'),
      autoNextToggle: id('autonext-toggle'),
    };

    this.#bindUi();
    this.#bindSocket();
    this.#bindSwipe();
    this.#bindKeys();
  }

  // ------------------------------------------------------------ public API

  /** Enter the room and start looking for someone right away. */
  open({ mode, interests = [], langOnly = false }) {
    this.mode = mode;
    this.search = { interests, langOnly };
    this.el.layout.dataset.mode = mode;
    this.#clearMessages();
    if (mode === 'video') this.#attachLocal();
    this.#find();
  }

  /** Leaving the room (Stop, back button…): end any chat and clean up. */
  close() {
    this.#stopSearching();
    for (const dialog of [this.el.dlgReport, this.el.dlgSettings]) if (dialog.open) dialog.close('');
    this.el.localVideo.srcObject = null;
    this.lastPairId = null;
    this.#clearMessages();
  }

  next() {
    if (this.state === 'idle') return void this.#find();
    if (this.state === 'searching') return;
    if (this.state === 'connected' || this.state === 'connecting') this.#addSystem(t('chat.youLeft'));
    this.#find();
  }

  #stopSearching() {
    this.#clearTimer('autoNext');
    if (this.state !== 'idle' && this.socket.connected) this.socket.emit('stop');
    this.#endPeer();
    this.resumeOnReconnect = false;
    this.#setState('idle');
  }

  // ------------------------------------------------------------ flow

  async #find() {
    this.#clearTimer('autoNext');
    this.#endPeer();
    this.#setState('searching');
    if (!this.socket.connected) {
      this.resumeOnReconnect = true; // the 'connect' handler will retry
      return;
    }
    const res = await request(this.socket, 'find', {
      mode: this.mode,
      interests: this.search.interests,
      langOnly: this.search.langOnly,
      lang: config.lang,
    });
    if (res?.ok || this.state !== 'searching') return;
    if (res?.error === 'auth_required' || res?.error === 'guidelines_required') {
      this.#setState('idle');
      return this.onAuthNeeded();
    }
    if (res?.error === 'rate_limited') {
      toast(t('error.rateLimited'));
      this.timers.autoNext = setTimeout(() => this.state === 'searching' && this.#find(), 3000);
    } else {
      this.resumeOnReconnect = true;
    }
  }

  #onMatched({ pairId, initiator, mode, partner, shared }) {
    if (this.state !== 'searching') {
      this.socket.emit('stop'); // we gave up meanwhile
      return;
    }
    this.pairId = pairId;
    this.partner = partner || {};
    this.#clearMessages();
    const country = this.partner.country ? countryName(this.partner.country) : '';
    this.#addSystem(country ? t('chat.connected', { country }) : t('chat.connectedUnknown'), 'good');
    if (shared?.length) this.#addSystem(t('chat.shared', { interests: formatList(shared.map(interestLabel)) }));
    this.#renderPartner();
    this.#onPartnerMedia({ audio: true, video: true });
    this.el.quickReplies.hidden = false;

    if (mode === 'video') {
      this.#setBlur(prefs.get('blur', false));
      const iceServers = this.hello?.iceServers?.length ? this.hello.iceServers : FALLBACK_ICE;
      this.peer = new Peer({
        iceServers,
        iceTransportPolicy: this.hello?.iceTransportPolicy || 'all',
        stream: this.camera.stream,
        initiator,
        send: (msg) => this.socket.emit('signal', { ...msg, pairId }),
      });
      this.peer.addEventListener('track', (event) => {
        this.el.remoteVideo.srcObject = event.detail;
        this.el.remoteVideo.play?.().catch(() => {});
      });
      this.peer.addEventListener('connected', () => this.#onPeerConnected());
      this.peer.addEventListener('failed', () => this.#onPeerFailed());
      this.#setState('connecting');
      this.timers.connect = setTimeout(() => this.#onPeerFailed(), CONNECT_TIMEOUT_MS);
      this.peer.start().catch(() => this.#onPeerFailed());
      this.#sendMediaState();
      if (coarsePointer() && !prefs.get('swiped', false)) {
        this.el.swipeHint.hidden = false;
        this.timers.swipeHint = setTimeout(() => (this.el.swipeHint.hidden = true), 5000);
      }
    } else {
      this.#setState('connected');
    }
    if (finePointer()) this.el.input.focus({ preventScroll: true });
    this.#notify();
  }

  #onPeerConnected() {
    this.#clearTimer('connect');
    if (this.state === 'connecting') this.#setState('connected');
  }

  #onPeerFailed() {
    if (this.state !== 'connecting' && this.state !== 'connected') return;
    this.#addSystem(t('chat.failed'));
    this.#find();
  }

  #onPartnerLeft() {
    this.#endPeer();
    this.#addSystem(t('chat.left'));
    this.#setState('ended');
    if (prefs.get('autoNext', true)) {
      this.timers.autoNext = setTimeout(() => this.state === 'ended' && this.#find(), AUTO_NEXT_DELAY_MS);
    }
  }

  #onDisconnect() {
    if (this.state === 'idle') return;
    const wasChatting = this.state === 'connected' || this.state === 'connecting';
    this.#endPeer();
    if (wasChatting) this.#addSystem(t('chat.reconnecting'));
    this.resumeOnReconnect = true;
    this.#setState('searching');
  }

  #onConnect() {
    if (this.resumeOnReconnect && this.state === 'searching') {
      this.resumeOnReconnect = false;
      this.#find();
    }
  }

  #endPeer() {
    this.#clearTimer('connect');
    this.#clearTimer('swipeHint');
    this.el.swipeHint.hidden = true;
    this.#setTyping(false);
    if (this.pairId) {
      this.lastPairId = this.pairId;
      this.lastPairAt = Date.now();
    }
    this.pairId = null;
    this.peer?.close();
    this.peer = null;
    this.el.remoteVideo.srcObject = null;
    this.#setPartnerTyping(false);
    this.#setBlur(false);
  }

  // ------------------------------------------------------------ camera & mic

  // Like Monkey: once permission is granted (in the lobby), camera and
  // microphone simply stay on for the whole video chat — no mute buttons.
  #attachLocal() {
    const stream = this.camera.stream;
    const video = this.el.localVideo;
    video.srcObject = stream;
    video.play?.().catch(() => {});
    for (const track of stream?.getTracks() ?? []) {
      track.onended = () => {
        // Camera or mic unplugged / taken by another app: tell the partner.
        this.el.localCamOff.hidden = this.camera.hasTrack('video');
        this.#sendMediaState();
      };
    }
    video.classList.toggle('mirrored', this.camera.facing !== 'environment');
    this.el.localCamOff.hidden = this.camera.hasTrack('video');
    this.camera.cameras().then((cameras) => {
      this.el.flipBtn.hidden = cameras.length < 2;
    });
  }

  /** Lets the partner know if this device has no working camera or microphone. */
  #sendMediaState() {
    if (!this.pairId || this.mode !== 'video') return;
    this.socket.emit('signal', {
      pairId: this.pairId,
      kind: 'media',
      audio: this.camera.hasTrack('audio'),
      video: this.camera.hasTrack('video'),
    });
  }

  #onPartnerMedia({ audio, video }) {
    this.el.remoteCamOff.hidden = video !== false;
    this.el.partnerMuted.hidden = audio !== false;
  }

  /** Camera switched (flip button or Settings): swap it into the live call. */
  async #onTrackChanged({ kind, track }) {
    if (!track) toast(t('media.inUse'));
    else await this.peer?.replaceTrack(kind, track).catch(() => {});
    if (this.mode === 'video') this.#attachLocal();
    this.#sendMediaState();
  }

  // ------------------------------------------------------------ messages

  async #send(raw) {
    const text = raw.trim();
    if (!text || !this.pairId) return;
    const pairId = this.pairId;
    const item = this.#addMessage('me', text);
    item.classList.add('is-pending');
    this.el.quickReplies.hidden = true;
    this.#setTyping(false);
    const res = await request(this.socket, 'message', { pairId, text });
    item.classList.remove('is-pending');
    if (res?.ok) {
      if (res.text && res.text !== text) item.querySelector('.msg-bubble').textContent = res.text;
      return;
    }
    item.classList.add('is-failed');
    const reason = { links_blocked: 'chat.linksBlocked', rate_limited: 'chat.slowDown' }[res?.error] ?? 'chat.notSent';
    toast(t(reason));
  }

  #onMessage({ text }) {
    if (typeof text !== 'string') return;
    this.#setPartnerTyping(false);
    this.el.quickReplies.hidden = true;
    this.#addMessage('them', text);
    this.#notify();
  }

  #addMessage(who, text) {
    const li = document.createElement('li');
    li.className = `msg msg-${who}`;
    const speaker = document.createElement('span');
    speaker.className = 'sr-only';
    speaker.textContent = `${who === 'me' ? t('self.label') : t('chat.stranger')}: `;
    const bubble = document.createElement('span');
    bubble.className = 'msg-bubble';
    bubble.dir = 'auto';
    bubble.textContent = text;
    li.append(speaker, bubble);
    this.#append(li, who === 'me');
    return li;
  }

  #addSystem(text, tone) {
    const li = document.createElement('li');
    li.className = `msg msg-system${tone ? ` tone-${tone}` : ''}`;
    li.textContent = text;
    this.#append(li, true);
  }

  #append(li, forceScroll) {
    const list = this.el.messages;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.append(li);
    while (list.children.length > MAX_MESSAGES) list.firstElementChild.remove();
    if (nearBottom || forceScroll) list.scrollTop = list.scrollHeight;
  }

  #clearMessages() {
    this.el.messages.replaceChildren();
  }

  #onInput() {
    if (!this.pairId) return;
    if (!this.typingSent) {
      this.typingSent = true;
      this.socket.emit('typing', { pairId: this.pairId, on: true });
    }
    this.#clearTimer('typing');
    this.timers.typing = setTimeout(() => this.#setTyping(false), 2500);
  }

  #setTyping(on) {
    if (on) return;
    this.#clearTimer('typing');
    if (this.typingSent && this.pairId) this.socket.emit('typing', { pairId: this.pairId, on: false });
    this.typingSent = false;
  }

  #setPartnerTyping(on) {
    this.#clearTimer('partnerTyping');
    this.el.typing.hidden = !on;
    if (on) this.timers.partnerTyping = setTimeout(() => (this.el.typing.hidden = true), 6000);
  }

  // ------------------------------------------------------------ safety

  #setBlur(on) {
    this.blurred = on;
    this.el.tileRemote.classList.toggle('is-blurred', on);
    this.el.revealBtn.hidden = !on;
  }

  async #report() {
    const recent = this.lastPairId && Date.now() - this.lastPairAt < LAST_PARTNER_REPORT_MS;
    const pairId = this.pairId || (recent ? this.lastPairId : null);
    if (!pairId) return toast(t('report.none'));

    const { dlgReport, reportForm, tileRemote } = this.el;
    reportForm.reset();
    tileRemote.classList.add('is-blurred'); // don't keep showing abuse while the user picks a reason
    const choice = await openDialog(dlgReport);
    const reason = new FormData(reportForm).get('reason');
    if (choice !== 'submit' || !reason) {
      this.#setBlur(this.blurred);
      return;
    }

    const isCurrent = pairId === this.pairId;
    if (isCurrent) this.#endPeer(); // the server ends the chat for both sides
    this.lastPairId = null;
    const res = await request(this.socket, 'report', { pairId, reason });
    toast(res?.ok ? t('report.thanks') : t('report.none'));
    if (isCurrent || this.state === 'ended') this.#find();
    else this.#setState(this.state); // refresh the report button
  }

  // ------------------------------------------------------------ rendering

  #setState(state) {
    this.state = state;
    const { layout, input, sendBtn, reportBtn, quickReplies, searchTip, panelFlag, panelCountry } = this.el;
    layout.dataset.state = state;
    const live = state === 'connecting' || state === 'connected';
    input.disabled = !live;
    sendBtn.disabled = !live;
    const canReportLast = this.lastPairId && Date.now() - this.lastPairAt < LAST_PARTNER_REPORT_MS;
    reportBtn.disabled = !(live || (canReportLast && state !== 'idle'));
    if (!live) {
      quickReplies.hidden = true;
      this.#setPartnerTyping(false);
      panelFlag.hidden = true;
      panelCountry.textContent =
        state === 'searching' ? t('chat.searching') : state === 'ended' ? t('chat.left') : t('chat.idle');
    }
    this.#clearTimer('tip');
    searchTip.hidden = true;
    if (state === 'searching') this.timers.tip = setTimeout(() => (searchTip.hidden = false), SEARCH_TIP_AFTER_MS);
    this.#radar(state === 'searching' && this.mode === 'video');
  }

  #renderPartner() {
    const code = this.partner?.country;
    const flag = flagEmoji(code);
    const name = code ? countryName(code) : t('chat.stranger');
    this.el.partnerFlag.textContent = flag;
    this.el.partnerCountry.textContent = name;
    this.el.partnerChip.hidden = false;
    this.el.panelFlag.textContent = flag;
    this.el.panelFlag.hidden = false;
    this.el.panelCountry.textContent = name;
  }

  /** Flags popping up around the radar while we search the planet. */
  #radar(on) {
    clearInterval(this.timers.radar);
    this.el.radarFlags.replaceChildren();
    if (!on || reducedMotion()) return;
    const spawn = () => {
      const el = document.createElement('span');
      el.className = 'radar-flag flag';
      el.textContent = flagEmoji(RADAR_COUNTRIES[Math.floor(Math.random() * RADAR_COUNTRIES.length)]);
      const angle = Math.random() * Math.PI * 2;
      const radius = 78 + Math.random() * 34;
      el.style.setProperty('--x', `${Math.round(Math.cos(angle) * radius)}px`);
      el.style.setProperty('--y', `${Math.round(Math.sin(angle) * radius)}px`);
      el.addEventListener('animationend', () => el.remove());
      this.el.radarFlags.append(el);
    };
    spawn();
    this.timers.radar = setInterval(spawn, 700);
  }

  #notify() {
    if (document.visibilityState === 'visible') return;
    if (!this.baseTitle) this.baseTitle = document.title;
    document.title = `💬 ${this.baseTitle}`;
  }

  #clearTimer(name) {
    clearTimeout(this.timers[name]);
    this.timers[name] = null;
  }

  // ------------------------------------------------------------ wiring

  #bindSocket() {
    const s = this.socket;
    s.on('hello', (hello) => {
      this.hello = hello;
    });
    s.on('matched', (m) => this.#onMatched(m));
    s.on('signal', (data) => {
      if (data?.pairId !== this.pairId) return;
      if (data.kind === 'media') this.#onPartnerMedia(data);
      else this.peer?.handle(data);
    });
    s.on('message', (m) => m?.pairId === this.pairId && this.#onMessage(m));
    s.on('typing', (m) => m?.pairId === this.pairId && this.#setPartnerTyping(m.on === true));
    s.on('partner_left', (m) => m?.pairId === this.pairId && this.#onPartnerLeft());
    s.on('disconnect', () => this.#onDisconnect());
    s.on('connect', () => this.#onConnect());
  }

  #bindUi() {
    const el = this.el;
    el.nextBtn.addEventListener('click', () => this.next());
    el.stopBtn.addEventListener('click', () => this.onLeave());
    el.flipBtn.addEventListener('click', () => this.camera.flip());
    this.camera.addEventListener('track', (event) => this.#onTrackChanged(event.detail));
    el.reportBtn.addEventListener('click', () => this.#report());
    el.settingsBtn.addEventListener('click', () => this.#openSettings());
    el.revealBtn.addEventListener('click', () => this.#setBlur(false));

    el.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = el.input.value;
      el.input.value = '';
      this.#send(text);
    });
    el.input.addEventListener('input', () => this.#onInput());
    el.quickReplies.addEventListener('click', (event) => {
      const chip = event.target.closest('.chip');
      if (!chip) return;
      this.#send(chip.dataset.quickText ?? t(chip.dataset.quick));
    });

    el.blurToggle.addEventListener('change', () => prefs.set('blur', el.blurToggle.checked));
    el.autoNextToggle.addEventListener('change', () => prefs.set('autoNext', el.autoNextToggle.checked));
    el.cameraSelect.addEventListener('change', () => this.camera.useDevice('video', el.cameraSelect.value));
    el.micSelect.addEventListener('change', () => this.camera.useDevice('audio', el.micSelect.value));

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.baseTitle) {
        document.title = this.baseTitle;
        this.baseTitle = null;
      }
    });
  }

  async #openSettings() {
    const { blurToggle, autoNextToggle, deviceFields, cameraSelect, micSelect, dlgSettings } = this.el;
    blurToggle.checked = prefs.get('blur', false);
    autoNextToggle.checked = prefs.get('autoNext', true);
    const stream = this.camera.stream;
    const hasMedia = this.mode === 'video' && Boolean(stream);
    deviceFields.hidden = !hasMedia;
    if (hasMedia) {
      const { cameras, mics } = await listDevices();
      const currentVideo = stream.getVideoTracks()[0]?.getSettings?.().deviceId;
      const currentAudio = stream.getAudioTracks()[0]?.getSettings?.().deviceId;
      fillSelect(cameraSelect, cameras, currentVideo, t('settings.camera'));
      fillSelect(micSelect, mics, currentAudio, t('settings.mic'));
    }
    await openDialog(dlgSettings);
  }

  #bindKeys() {
    // Capture phase: runs before an open <dialog> handles Esc itself.
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || event.repeat || document.body.dataset.view !== 'chat') return;
        if (document.querySelector('dialog[open]')) return;
        event.preventDefault();
        this.next();
      },
      true,
    );
  }

  /** Monkey-style: swipe the stranger away to meet the next person. */
  #bindSwipe() {
    const tile = this.el.tileRemote;
    let drag = null;
    const canSwipe = () => this.mode === 'video' && ['connecting', 'connected', 'ended'].includes(this.state);

    tile.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch' || !canSwipe() || event.target.closest('button')) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, locked: false };
    });
    tile.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.locked) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          drag = null;
          return;
        }
        drag.locked = true;
        tile.classList.add('is-dragging');
        try {
          tile.setPointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
      }
      drag.dx = dx;
      tile.style.transform = `translateX(${dx}px) rotate(${dx / 30}deg)`;
      tile.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / 500));
    });
    const end = () => {
      if (!drag) return;
      const { dx, locked } = drag;
      drag = null;
      tile.classList.remove('is-dragging');
      if (!locked) return;
      if (Math.abs(dx) > Math.min(110, tile.clientWidth * 0.25) && canSwipe()) {
        const dir = Math.sign(dx);
        tile.style.transform = `translateX(${dir * tile.clientWidth}px) rotate(${dir * 14}deg)`;
        tile.style.opacity = '0';
        setTimeout(() => {
          tile.classList.add('is-dragging');
          tile.style.transform = '';
          tile.style.opacity = '';
          void tile.offsetWidth;
          tile.classList.remove('is-dragging');
        }, 230);
        prefs.set('swiped', true);
        this.next();
      } else {
        tile.style.transform = '';
        tile.style.opacity = '';
      }
    };
    tile.addEventListener('pointerup', end);
    tile.addEventListener('pointercancel', end);
  }
}

function fillSelect(select, devices, currentId, fallbackLabel) {
  select.replaceChildren(
    ...devices.map((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `${fallbackLabel} ${index + 1}`;
      option.selected = device.deviceId === currentId;
      return option;
    }),
  );
  select.disabled = devices.length < 2;
}
