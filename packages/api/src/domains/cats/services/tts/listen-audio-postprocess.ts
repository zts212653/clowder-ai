export const LISTEN_AUDIO_CACHE_VERSION = 'listen-continuity-v1';

const DEFAULT_THRESHOLD_DB = -40;
const DEFAULT_WINDOW_MS = 10;
const DEFAULT_PREROLL_MS = 20;

interface Pcm16WavLayout {
  blockAlign: number;
  channels: number;
  dataOffset: number;
  dataSize: number;
  dataSizeOffset: number;
  sampleRate: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function parsePcm16Wav(audio: Uint8Array): Pcm16WavLayout | null {
  if (audio.byteLength < 44 || ascii(audio, 0, 4) !== 'RIFF' || ascii(audio, 8, 4) !== 'WAVE') return null;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let blockAlign: number | undefined;
  let pcm16 = false;

  for (let offset = 12; offset + 8 <= audio.byteLength; ) {
    const chunkId = ascii(audio, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    const chunkEnd = chunkDataOffset + chunkSize;
    if (chunkEnd > audio.byteLength) return null;

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      pcm16 = view.getUint16(chunkDataOffset, true) === 1 && view.getUint16(chunkDataOffset + 14, true) === 16;
      channels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      blockAlign = view.getUint16(chunkDataOffset + 12, true);
    } else if (
      chunkId === 'data' &&
      pcm16 &&
      channels &&
      sampleRate &&
      blockAlign &&
      blockAlign >= channels * 2 &&
      chunkSize % blockAlign === 0
    ) {
      return {
        blockAlign,
        channels,
        dataOffset: chunkDataOffset,
        dataSize: chunkSize,
        dataSizeOffset: offset + 4,
        sampleRate,
      };
    }

    offset = chunkEnd + (chunkSize % 2);
  }
  return null;
}

export function pcm16WavDurationSec(audio: Uint8Array): number | undefined {
  const layout = parsePcm16Wav(audio);
  if (!layout) return undefined;
  return layout.dataSize / layout.blockAlign / layout.sampleRate;
}

export function trimLeadingPcm16Wav(audio: Uint8Array): Uint8Array {
  const layout = parsePcm16Wav(audio);
  if (!layout) return audio;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const frameCount = Math.floor(layout.dataSize / layout.blockAlign);
  const windowFrames = Math.max(1, Math.round((layout.sampleRate * DEFAULT_WINDOW_MS) / 1000));
  const threshold = 32_767 * 10 ** (DEFAULT_THRESHOLD_DB / 20);
  let signalFrame = -1;

  for (let startFrame = 0; startFrame < frameCount; startFrame += windowFrames) {
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

  if (signalFrame < 0) return audio;
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
