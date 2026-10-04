const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

function saveSyntheticAudio(storage, base64) {
  if (typeof base64 !== 'string' || base64.length > 8_000_000) throw new Error('Audio evidence too large');
  writeFileSync(resolve(storage, 'synthetic-reply.webm'), Buffer.from(base64, 'base64'), { mode: 0o600 });
}
function saveSyntheticMedia(storage, value) {
  if (value?.type !== 'media' || value.synthetic !== true) return;
  const receipt = {
    observedAt: new Date().toISOString(),
    synthetic: true,
    microphoneCaptured: value.microphoneCaptured === true,
    connection: ['connected', 'disconnected', 'failed', 'closed'].includes(value.connection)
      ? value.connection
      : 'unknown',
    playbackStarted: value.playback?.outputCreated === true && value.playback?.paused === false,
    muted: value.playback?.muted === true,
    inbound: Array.isArray(value.inbound)
      ? value.inbound.slice(0, 4).map((row) => ({
          bytesReceived: Number.isFinite(row?.bytesReceived) ? row.bytesReceived : null,
          totalAudioEnergy: Number.isFinite(row?.totalAudioEnergy) ? row.totalAudioEnergy : null,
        }))
      : [],
  };
  writeFileSync(resolve(storage, 'synthetic-media.json'), JSON.stringify(receipt), { mode: 0o600 });
}
module.exports = { saveSyntheticAudio, saveSyntheticMedia };
