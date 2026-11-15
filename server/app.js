// Wires the HTTP app, accounts, Socket.IO and the chat layer together. Used
// by server/index.js and by the integration tests.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { GoogleVerifier, createAuthRouter } from './auth.js';
import { attachChat } from './chat-server.js';
import { createIpTools } from './client-ip.js';
import { IceProvider } from './ice.js';
import { FileStore, Moderation } from './moderation.js';
import { Renderer } from './render.js';
import { UserStore } from './users.js';
import { createWebApp } from './web.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function originChecker(config) {
  const allowed = new Set(config.allowedOrigins.map((o) => o.replace(/\/+$/, '')));
  if (config.publicUrl) allowed.add(new URL(config.publicUrl).origin);
  if (!allowed.size) return (req, callback) => callback(null, true);
  // Browsers always send Origin on websocket/XHR requests; other sites can't
  // embed our matchmaking. (Not a security boundary — scripts can fake it.)
  return (req, callback) => {
    const origin = req.headers.origin;
    callback(null, !origin || allowed.has(origin));
  };
}

/**
 * Without SERVER_SECRET we generate one and keep it in DATA_DIR, so sign-ins
 * and IP-hash bans survive restarts during development.
 */
function persistentSecret(dataDir, logger) {
  const file = path.join(path.resolve(dataDir), '.secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch {
    /* not created yet */
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  } catch (err) {
    logger.warn(`[config] could not save a secret in ${dataDir} (${err.message}); sessions reset on restart`);
    return null;
  }
}

/**
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {{ logger?: Console, store?: FileStore | null, users?: UserStore, ice?: IceProvider,
 *           google?: GoogleVerifier }} [deps]  store: null = keep everything in memory (tests)
 */
export function createServer(config, { logger = console, store, users, ice, google } = {}) {
  const inMemory = store === null;
  if (config.secretIsEphemeral && !inMemory) config.secret = persistentSecret(config.dataDir, logger) ?? config.secret;

  const fileStore = inMemory ? null : (store ?? new FileStore(config.dataDir, { logger }));
  const userStore = users ?? new UserStore({ file: inMemory ? null : path.join(config.dataDir, 'users.json'), logger });
  const moderation = new Moderation({
    threshold: config.moderation.reportThreshold,
    windowMs: config.moderation.reportWindowMs,
    banMs: config.moderation.banMs,
    ipBanMs: config.moderation.ipBanMs,
    banIp: config.moderation.banIp,
    store: fileStore,
  });
  const iceProvider = ice ?? new IceProvider(config.ice, { logger });
  const renderer = new Renderer({ root: ROOT, config, cache: config.isProduction });
  const ip = createIpTools(config);
  const authRouter = createAuthRouter({
    config,
    users: userStore,
    moderation,
    google: google ?? new GoogleVerifier({ clientId: config.auth.googleClientId }),
    clientKeyOf: ip.ipHashOf,
    logger,
  });

  let chat;
  const app = createWebApp({
    config,
    renderer,
    publicDir: path.join(ROOT, 'public'),
    getStats: (full) => chat.stats(full),
    moderation,
    users: userStore,
    authRouter,
    kick: (keys, until) => chat.kick(keys, until),
    logger,
  });

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    serveClient: true,
    pingInterval: 20_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 256 * 1024,
    allowRequest: originChecker(config),
  });
  chat = attachChat(io, { config, ice: iceProvider, moderation, users: userStore, ipHashOf: ip.ipHashOf, logger });

  return {
    app,
    io,
    chat,
    moderation,
    users: userStore,
    renderer,
    httpServer,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          resolve(httpServer.address());
        });
      });
    },
    async close() {
      chat.close();
      fileStore?.flush();
      userStore.flush();
      await new Promise((resolve) => io.close(() => resolve()));
      if (httpServer.listening) await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}
