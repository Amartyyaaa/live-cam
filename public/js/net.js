import { io } from '/socket.io/socket.io.esm.min.js';

/**
 * One Socket.IO connection per tab. WebSocket first, with automatic fallback to
 * HTTP long-polling for networks (offices, some countries) that block it.
 */
export function connect({ clientId, lang }) {
  let tz;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    tz = undefined;
  }
  return io({
    auth: { clientId, lang, tz },
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 8000,
    timeout: 15000,
  });
}

/** emit + wait for the server's acknowledgement; never throws. */
export async function request(socket, event, payload, timeout = 8000) {
  try {
    return await socket.timeout(timeout).emitWithAck(event, payload);
  } catch {
    return { ok: false, error: 'timeout' };
  }
}
