#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { createServer } from './app.js';

const config = loadConfig();
const server = createServer(config);

// Locally, if port 3000 is taken by another app, try the next few ports.
// When PORT is set explicitly (hosting platforms do this) we never move.
async function listen() {
  const fixedPort = Boolean(process.env.PORT);
  let port = config.port;
  for (let attempt = 0; ; attempt++) {
    try {
      return await server.listen(port);
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || fixedPort || attempt >= 9) throw err;
      console.warn(`Port ${port} is busy, trying ${port + 1}…`);
      port++;
    }
  }
}

// Used by start-windows.bat: open the browser only once we're really listening.
function openBrowser(url) {
  const [cmd, args, extra] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url], { windowsVerbatimArguments: true }]
      : process.platform === 'darwin'
        ? ['open', [url], {}]
        : ['xdg-open', [url], {}];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, ...extra });
    child.on('error', () => console.log(`Open ${url} in your browser.`));
    child.unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

try {
  const address = await listen();
  const shownHost = ['0.0.0.0', '::'].includes(address.address) ? 'localhost' : address.address;
  const url = `http://${shownHost}:${address.port}`;
  console.log(`${config.appName} is live → ${url}`);
  if (process.env.OPEN_BROWSER === '1') openBrowser(url);
} catch (err) {
  const hint = err.code === 'EADDRINUSE' ? ' (another program is using this port — close it or set PORT)' : '';
  console.error(`Could not start the server: ${err.message}${hint}`);
  process.exit(1);
}

if (!config.ice.turnUrls.length && !config.ice.cloudflareKeyId) {
  console.warn(
    '[ice] No TURN server configured. Most people will connect fine, but users behind strict NATs or mobile\n' +
      '      carrier networks may fail to see each other. Set TURN_URLS + TURN_SECRET (see README).',
  );
}
if (config.isProduction && config.secretIsEphemeral) {
  console.warn('[config] SERVER_SECRET is not set — IP-based bans will reset on every restart.');
}
if (config.isProduction && config.contactEmail === 'support@example.com') {
  console.warn('[config] CONTACT_EMAIL is not set — your legal pages show support@example.com.');
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, shutting down…`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await server.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
