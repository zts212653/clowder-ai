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

export function parsePcm16Wav(audio: Uint8Array): Pcm16WavLayout | null {
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
