#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createServer } from './app.js';

const config = loadConfig();
const server = createServer(config);

try {
  const address = await server.listen();
  const shownHost = ['0.0.0.0', '::'].includes(address.address) ? 'localhost' : address.address;
  console.log(`${config.appName} is live → http://${shownHost}:${address.port}`);
} catch (err) {
  console.error(`Could not start the server: ${err.message}`);
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
