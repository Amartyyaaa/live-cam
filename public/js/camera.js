// The local camera + microphone, shared by the lobby (preview) and the chat
// room, so permission is asked once and the stream survives between them.

import { listDevices, openCamera, openLocalMedia, openMic, stopStream } from './media.js';
import { prefs } from './prefs.js';

export class Camera extends EventTarget {
  constructor() {
    super();
    this.stream = null;
    this.generation = 0; // bumps on stop(): cancels an open() still waiting for permission
  }

  get live() {
    return Boolean(this.stream?.getTracks().some((track) => track.readyState === 'live'));
  }

  hasTrack(kind) {
    return Boolean(this.stream?.getTracks().some((track) => track.kind === kind && track.readyState === 'live'));
  }

  /** "user" (front / webcam) or "environment" (back camera). */
  get facing() {
    return this.stream?.getVideoTracks()[0]?.getSettings?.().facingMode === 'environment' ? 'environment' : 'user';
  }

  /** Asks for permission (first time) and starts the camera. Resolves null if stopped meanwhile. */
  async open() {
    if (this.live) return this.stream;
    const generation = this.generation;
    const stream = await openLocalMedia({ cameraId: prefs.get('cameraId'), micId: prefs.get('micId') });
    if (generation !== this.generation) {
      stopStream(stream);
      return null;
    }
    this.stream = stream;
    for (const track of stream.getTracks()) track.enabled = true;
    this.#changed();
    return stream;
  }

  stop() {
    this.generation++;
    if (!this.stream) return;
    stopStream(this.stream);
    this.stream = null;
    this.#changed();
  }

  async cameras() {
    return (await listDevices()).cameras;
  }

  /** Front ↔ back camera (or the next webcam). */
  async flip() {
    const cameras = await this.cameras();
    if (cameras.length < 2) return null;
    const current = this.stream?.getVideoTracks()[0]?.getSettings?.().deviceId;
    const index = cameras.findIndex((c) => c.deviceId === current);
    return this.useDevice('video', cameras[(index + 1) % cameras.length].deviceId);
  }

  /** Switches camera or microphone in place; listeners swap the track on the call. */
  async useDevice(kind, deviceId) {
    if (!this.stream) return null;
    const old = kind === 'video' ? this.stream.getVideoTracks()[0] : this.stream.getAudioTracks()[0];
    if (old && old.getSettings?.().deviceId === deviceId) return old;
    old?.stop(); // many phones can't open two cameras at once
    const open = kind === 'video' ? openCamera : openMic;
    let track = null;
    try {
      track = await open(deviceId);
    } catch {
      track = await open(undefined).catch(() => null);
    }
    if (old) this.stream.removeTrack(old);
    if (track) {
      this.stream.addTrack(track);
      prefs.set(kind === 'video' ? 'cameraId' : 'micId', track.getSettings?.().deviceId ?? deviceId);
    }
    this.dispatchEvent(new CustomEvent('track', { detail: { kind, track } }));
    this.#changed();
    return track;
  }

  #changed() {
    this.dispatchEvent(new Event('change'));
  }
}
