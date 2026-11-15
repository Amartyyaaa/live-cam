// Wires the HTTP app, Socket.IO and the chat layer together. Used by
// server/index.js and by the integration tests.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { attachChat } from './chat-server.js';
import { IceProvider } from './ice.js';
import { FileStore, Moderation } from './moderation.js';
import { Renderer } from './render.js';
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
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {{ logger?: Console, store?: FileStore | null, ice?: IceProvider }} [deps]
 */
export function createServer(config, { logger = console, store, ice } = {}) {
  const fileStore = store === undefined ? new FileStore(config.dataDir, { logger }) : store;
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

  let chat;
  const app = createWebApp({
    config,
    renderer,
    publicDir: path.join(ROOT, 'public'),
    getStats: (full) => chat.stats(full),
    moderation,
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
  chat = attachChat(io, { config, ice: iceProvider, moderation, trustFn: app.get('trust proxy fn'), logger });

  return {
    app,
    io,
    chat,
    moderation,
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
      await new Promise((resolve) => io.close(() => resolve()));
      if (httpServer.listening) await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}
