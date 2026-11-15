// Entry point. Four screens, one socket:
//
//   home  ──Start──▶  auth (if signed out) ──▶ guidelines (once) ──▶ lobby ──Start──▶ chat
//
// Every screen is a history entry, so the phone's back button / gesture
// always goes one step back instead of leaving the site.

import { Account } from './account.js';
import { Camera } from './camera.js';
import { Chat } from './chat.js';
import { config, formatDateTime, formatNumber, t } from './i18n.js';
import { playIntro } from './intro.js';
import { Lobby } from './lobby.js';
import { connect } from './net.js';
import { clientId, prefs } from './prefs.js';
import { $, $$, openDialog, toast } from './ui.js';

const socket = connect({ clientId: clientId(), lang: config.lang });
const camera = new Camera();
const views = { home: $('#view-home'), auth: $('#view-auth'), lobby: $('#view-lobby'), chat: $('#view-chat') };
let current = 'home';

const account = new Account({ onBanned: (until) => showBanned(until) });
const chat = new Chat({
  socket,
  camera,
  onLeave: () => back('lobby'),
  onAuthNeeded: () => {
    go('home', { replace: true });
    begin(lobby.mode);
  },
});
const lobby = new Lobby({
  camera,
  account,
  onStart: (options) => {
    go('chat');
    chat.open(options);
  },
  onLeave: () => back('home'),
});

// ------------------------------------------------------------------ routing

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  document.body.dataset.view = name;
  if (name !== 'home') window.scrollTo(0, 0);
}

function transition(next) {
  const prev = current;
  if (prev === next) return;
  current = next;
  if (prev === 'chat') chat.close();
  if (prev === 'auth') account.cancelSignIn();
  if (prev === 'lobby') lobby.hide();
  if (next !== 'lobby' && next !== 'chat') camera.stop(); // camera only while in the lobby / chat
  show(next);
  if (next === 'lobby') lobby.show();
}

function go(name, { replace = false } = {}) {
  const url = location.pathname + location.search + (name === 'home' ? '' : `#${name}`);
  history[replace ? 'replaceState' : 'pushState']({ view: name }, '', url);
  transition(name);
}

/** Back one step if that's where we came from, otherwise jump there. */
function back(fallback) {
  if (history.state?.view && history.state.view !== 'home' && history.length > 1) history.back();
  else go(fallback, { replace: true });
}

window.addEventListener('popstate', (event) => transition(event.state?.view ?? 'home'));
if (location.hash) history.replaceState({ view: 'home' }, '', location.pathname + location.search);

for (const button of $$('[data-back]')) button.addEventListener('click', () => back('home'));
$('#chat-home').addEventListener('click', () => back('lobby'));

// --------------------------------------------------------------------- flow

/** From any "Start" button: sign in → guidelines → lobby. */
let beginning = false;
async function begin(mode = 'video') {
  if (beginning) return; // a double tap shouldn't start two flows
  beginning = true;
  try {
    await account.loaded;
    if (config.auth.required) {
      if (!account.user) {
        go('auth');
        const user = await account.waitForSignIn();
        if (!user) return; // they went back
      }
      if (!account.user.guidelinesAccepted) {
        const accepted = await account.askGuidelines();
        if (!accepted) {
          if (current === 'auth') back('home');
          toast(t('guide.declined'));
          return;
        }
      }
    } else if (prefs.get('guidelines') !== true) {
      // Anonymous mode still has the 18+ gate, remembered in this browser.
      if (!(await account.askGuidelines())) return void toast(t('guide.declined'));
      prefs.set('guidelines', true);
    }
    lobby.mode = mode === 'text' ? 'text' : 'video'; // before showing it, so text mode never opens the camera
    go('lobby', { replace: current === 'auth' });
  } finally {
    beginning = false;
  }
}

for (const button of $$('[data-start]')) button.addEventListener('click', () => begin(button.dataset.start));
for (const button of $$('[data-signin]')) {
  button.addEventListener('click', async () => {
    go('auth');
    const user = await account.waitForSignIn();
    if (user && current === 'auth') back('home');
  });
}

// The socket handshake carries the session cookie: reconnect after it changes.
const refreshSocket = () => {
  socket.disconnect();
  socket.connect();
};
account.addEventListener('signedin', refreshSocket);
account.addEventListener('signedout', () => {
  refreshSocket();
  if (current === 'lobby' || current === 'chat') go('home', { replace: true });
});

// ------------------------------------------------------------- landing page

const introCanvas = $('#intro-canvas');
if (introCanvas) {
  playIntro(introCanvas, {
    text: config.appName,
    onFormed: () => $('#intro').classList.add('is-formed'),
  });
}

const picker = $('#lang-picker');
for (const link of $$('.lang-menu a', picker)) {
  link.addEventListener('click', () => {
    document.cookie = `lang=${link.dataset.lang}; path=/; max-age=31536000; samesite=lax`;
  });
}
document.addEventListener('click', (event) => {
  if (picker.open && !picker.contains(event.target)) picker.open = false;
});

// ---------------------------------------------------------------- live count

function setOnline(count) {
  if (typeof count !== 'number') return;
  const text = t('online', { count: formatNumber(count) });
  for (const el of $$('[data-online-count]')) el.textContent = text;
  for (const el of $$('[data-online-pill]')) el.hidden = false;
}
socket.on('hello', (hello) => {
  setOnline(hello.online);
  if (hello.clientId && hello.clientId !== prefs.get('clientId')) {
    prefs.set('clientId', hello.clientId);
    socket.auth.clientId = hello.clientId;
  }
});
socket.on('stats', (stats) => setOnline(stats.online));

// -------------------------------------------------------- bans & connectivity

async function showBanned(until) {
  if (current !== 'home') go('home', { replace: true });
  $('#banned-text').textContent = t('error.banned.text', { time: formatDateTime(until) });
  await openDialog($('#dlg-banned'));
}
socket.on('banned', ({ until }) => showBanned(until));

let warnedOffline = false;
socket.on('connect_error', (err) => {
  const code = err?.data?.code;
  if (code === 'banned') return void showBanned(err.data.until);
  if (code === 'rate_limited') setTimeout(() => socket.connect(), 5000);
  if (!warnedOffline) {
    warnedOffline = true;
    toast(t('error.offline'));
  }
});
socket.on('connect', () => {
  warnedOffline = false;
});

// Debug/testing hook (harmless in production): lets automated tests observe state.
window.__app = { socket, chat, lobby, account, camera };
