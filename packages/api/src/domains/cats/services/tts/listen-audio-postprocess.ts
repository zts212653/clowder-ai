import { parsePcm16Wav } from '@cat-cafe/shared';

export const LISTEN_AUDIO_CACHE_VERSION = 'listen-continuity-v1';

const DEFAULT_THRESHOLD_DB = -40;
const DEFAULT_WINDOW_MS = 10;
const DEFAULT_PREROLL_MS = 20;

export function pcm16WavDurationSec(audio: Uint8Array): number | undefined {
  const layout = parsePcm16Wav(audio);
  if (!layout) return undefined;
  return layout.dataSize / layout.blockAlign / layout.sampleRate;
}

export function trimLeadingPcm16Wav(audio: Uint8Array): Uint8Array {
  return trimPcm16Silence(audio, false) ?? audio;
}

/** A complete window at speech onset makes trimming the prefix equivalent to trimming the full WAV. */
export function trimAudiblePcm16Prefix(audio: Uint8Array): Uint8Array | null {
  return trimPcm16Silence(audio, true);
}

function trimPcm16Silence(audio: Uint8Array, completeWindowsOnly: boolean): Uint8Array | null {
  const layout = parsePcm16Wav(audio);
  if (!layout) return null;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const frameCount = Math.floor(layout.dataSize / layout.blockAlign);
  const windowFrames = Math.max(1, Math.round((layout.sampleRate * DEFAULT_WINDOW_MS) / 1000));
  const threshold = 32_767 * 10 ** (DEFAULT_THRESHOLD_DB / 20);
  let signalFrame = -1;

  const scanFrames = completeWindowsOnly ? frameCount - (frameCount % windowFrames) : frameCount;
  for (let startFrame = 0; startFrame < scanFrames; startFrame += windowFrames) {
    const endFrame = Math.min(frameCount, startFrame + windowFrames);
    let squaredTotal = 0;
    let sampleCount = 0;
    for (let frame = startFrame; frame < endFrame; frame++) {
      const frameOffset = layout.dataOffset + frame * layout.blockAlign;
      for (let channel = 0; channel < layout.channels; channel++) {
        const sample = view.getInt16(frameOffset + channel * 2, true);
        squaredTotal += sample * sample;
        sampleCount++;
      }
    }
    if (Math.sqrt(squaredTotal / sampleCount) >= threshold) {
      signalFrame = startFrame;
      break;
    }
  }

  if (signalFrame < 0) return null;
  const prerollFrames = Math.round((layout.sampleRate * DEFAULT_PREROLL_MS) / 1000);
  const trimFrames = Math.max(0, signalFrame - prerollFrames);
  const trimBytes = trimFrames * layout.blockAlign;
  if (trimBytes === 0) return audio;

  const output = new Uint8Array(audio.byteLength - trimBytes);
  output.set(audio.subarray(0, layout.dataOffset), 0);
  output.set(audio.subarray(layout.dataOffset + trimBytes), layout.dataOffset);
  const outputView = new DataView(output.buffer);
  outputView.setUint32(4, output.byteLength - 8, true);
  outputView.setUint32(layout.dataSizeOffset, layout.dataSize - trimBytes, true);
  return output;
}
