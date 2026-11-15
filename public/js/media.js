// Camera & microphone helpers.

export const mediaSupported =
  typeof navigator !== 'undefined' &&
  Boolean(navigator.mediaDevices?.getUserMedia) &&
  typeof RTCPeerConnection !== 'undefined';

// 640×480 keeps video smooth on mid-range phones and slow mobile networks,
// which is most of the world. WebRTC adapts further when bandwidth drops.
export const VIDEO_CONSTRAINTS = {
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 24, max: 30 },
};
export const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

function videoConstraints({ deviceId, facingMode = 'user' } = {}) {
  return { ...VIDEO_CONSTRAINTS, ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode }) };
}
function audioConstraints({ deviceId } = {}) {
  return { ...AUDIO_CONSTRAINTS, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) };
}

/**
 * Opens camera + microphone. If one of them is missing (desktop without a
 * mic, or a laptop with a broken webcam) we still continue with the other.
 */
export async function openLocalMedia({ cameraId, micId } = {}) {
  const gum = (c) => navigator.mediaDevices.getUserMedia(c);
  try {
    return await gum({ video: videoConstraints({ deviceId: cameraId }), audio: audioConstraints({ deviceId: micId }) });
  } catch (err) {
    // A remembered device may have been unplugged — retry with defaults.
    if (err?.name === 'OverconstrainedError' && (cameraId || micId)) return openLocalMedia();
    if (err?.name !== 'NotFoundError') throw err;
    try {
      return await gum({ video: videoConstraints() });
    } catch {
      return gum({ audio: audioConstraints() });
    }
  }
}

export async function openCamera(deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints({ deviceId }) });
  return stream.getVideoTracks()[0];
}

export async function openMic(deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints({ deviceId }) });
  return stream.getAudioTracks()[0];
}

/** Maps getUserMedia errors to the messages we show. */
export function mediaErrorKind(err) {
  switch (err?.name) {
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'notFound';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'inUse';
    default:
      return 'denied';
  }
}

export async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      cameras: devices.filter((d) => d.kind === 'videoinput'),
      mics: devices.filter((d) => d.kind === 'audioinput'),
    };
  } catch {
    return { cameras: [], mics: [] };
  }
}

export function stopStream(stream) {
  for (const track of stream?.getTracks() ?? []) track.stop();
}
