// Entry point: one socket, two views (home + chat), browser history aware.

import { Chat } from './chat.js';
import { initHome } from './home.js';
import { config, formatDateTime, formatNumber, t } from './i18n.js';
import { connect } from './net.js';
import { clientId, prefs } from './prefs.js';
import { $, $$, openDialog, toast } from './ui.js';

const socket = connect({ clientId: clientId(), lang: config.lang });
const homeView = $('#view-home');
const chatView = $('#view-chat');

function show(view) {
  homeView.hidden = view !== 'home';
  chatView.hidden = view !== 'chat';
  document.body.dataset.view = view;
}

const chat = new Chat({ socket, onLeave: leaveChat });

function enterChat(options) {
  show('chat');
  history.pushState({ view: 'chat' }, '', '#chat');
  chat.open(options);
}

// The phone's back button / gesture closes the chat instead of leaving the site.
function leaveChat() {
  if (history.state?.view === 'chat') history.back();
  else {
    chat.close();
    show('home');
  }
}
window.addEventListener('popstate', () => {
  if (!chatView.hidden && history.state?.view !== 'chat') {
    chat.close();
    show('home');
  }
});
if (location.hash === '#chat') history.replaceState(null, '', location.pathname + location.search);

$('#chat-home').addEventListener('click', leaveChat);
initHome({ onStart: enterChat });

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

// ------------------------------------------------------ bans & connectivity
async function showBanned(until) {
  if (!chatView.hidden) {
    chat.close();
    show('home');
    if (history.state?.view === 'chat') history.replaceState(null, '', location.pathname + location.search);
  }
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
window.__app = { socket, chat };
