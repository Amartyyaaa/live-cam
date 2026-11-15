// One WebRTC connection to one stranger.
//
// Roles are decided by the server: the "initiator" creates the offer, the
// other side answers. Signalling messages are processed strictly in order and
// ICE candidates that arrive before the remote description are buffered.

const DISCONNECT_GRACE_MS = 6000;
const MAX_VIDEO_BITRATE = 900_000; // ~0.9 Mbps: friendly to mobile data plans

export class Peer extends EventTarget {
  /**
   * @param {{ iceServers: RTCIceServer[], iceTransportPolicy?: RTCIceTransportPolicy,
   *           stream: MediaStream | null, initiator: boolean, send: (msg: object) => void }} opts
   */
  constructor({ iceServers, iceTransportPolicy = 'all', stream, initiator, send }) {
    super();
    this.initiator = initiator;
    this.send = send;
    this.closed = false;
    this.connected = false;
    this.pendingCandidates = [];
    this.queue = Promise.resolve();
    this.disconnectTimer = null;

    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy, bundlePolicy: 'max-bundle' });
    const kinds = new Set();
    for (const track of stream?.getTracks() ?? []) {
      this.pc.addTrack(track, stream);
      kinds.add(track.kind);
    }
    // Still receive what we can't send (e.g. no microphone on this device).
    for (const kind of ['audio', 'video']) {
      if (!kinds.has(kind)) this.pc.addTransceiver(kind, { direction: 'recvonly' });
    }

    this.remoteStream = new MediaStream();
    this.pc.ontrack = (event) => {
      const [remote] = event.streams;
      if (remote) this.remoteStream = remote;
      else this.remoteStream.addTrack(event.track);
      this.#emit('track', this.remoteStream);
    };
    this.pc.onicecandidate = (event) => {
      if (event.candidate && !this.closed) this.send({ kind: 'ice', candidate: event.candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => this.#onState();
    this.pc.oniceconnectionstatechange = () => this.#onState();
  }

  async start() {
    if (!this.initiator || this.closed) return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.send({ kind: 'sdp', description: this.pc.localDescription.toJSON() });
  }

  /** Feed a signalling message ({kind:'sdp'|'ice'}) from the partner. */
  handle(message) {
    this.queue = this.queue.then(() => this.#handle(message)).catch((err) => console.warn('[peer]', err));
  }

  async #handle(message) {
    if (this.closed) return;
    if (message.kind === 'sdp') {
      await this.pc.setRemoteDescription(message.description);
      for (const candidate of this.pendingCandidates.splice(0)) {
        await this.pc.addIceCandidate(candidate).catch(() => {});
      }
      if (message.description.type === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.send({ kind: 'sdp', description: this.pc.localDescription.toJSON() });
      }
    } else if (message.kind === 'ice') {
      if (!this.pc.remoteDescription) this.pendingCandidates.push(message.candidate);
      else await this.pc.addIceCandidate(message.candidate).catch(() => {});
    }
  }

  #onState() {
    if (this.closed) return;
    const state = this.pc.connectionState || this.pc.iceConnectionState;
    const ice = this.pc.iceConnectionState;
    if (state === 'connected' || ice === 'connected' || ice === 'completed') {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
      if (!this.connected) {
        this.connected = true;
        this.#limitBitrate();
        this.#emit('connected');
      }
    } else if (state === 'failed' || ice === 'failed') {
      this.#emit('failed');
    } else if ((state === 'disconnected' || ice === 'disconnected') && !this.disconnectTimer) {
      // Brief network blips (switching Wi-Fi → 4G) often recover by themselves.
      this.disconnectTimer = setTimeout(() => {
        const s = this.pc.connectionState || this.pc.iceConnectionState;
        if (s !== 'connected' && s !== 'completed') this.#emit('failed');
      }, DISCONNECT_GRACE_MS);
    }
  }

  #limitBitrate() {
    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE;
        sender.setParameters(params).catch(() => {});
      } catch {
        /* not supported — WebRTC congestion control still applies */
      }
    }
  }

  /** Swap camera or microphone without renegotiating. */
  async replaceTrack(kind, track) {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === kind);
    if (sender) await sender.replaceTrack(track);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.disconnectTimer);
    this.pc.ontrack = this.pc.onicecandidate = this.pc.onconnectionstatechange = this.pc.oniceconnectionstatechange = null;
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
  }
}
