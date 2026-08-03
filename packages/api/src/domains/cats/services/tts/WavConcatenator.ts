interface ParsedPcmWav {
  readonly fmt: Buffer;
  readonly data: Buffer;
  readonly byteRate: number;
  readonly blockAlign: number;
}

function parsePcmWav(input: Uint8Array): ParsedPcmWav {
  const wav = Buffer.from(input);
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('TTS provider returned an invalid WAV segment');
  }

  let fmt: Buffer | undefined;
  const dataChunks: Buffer[] = [];
  let offset = 12;

  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > wav.length) {
      throw new Error(`TTS provider returned a truncated WAV ${id} chunk`);
    }

    if (id === 'fmt ' && fmt == null) {
      fmt = Buffer.from(wav.subarray(dataStart, dataEnd));
    } else if (id === 'data') {
      dataChunks.push(Buffer.from(wav.subarray(dataStart, dataEnd)));
    }

    offset = dataEnd + (size % 2);
  }

  if (!fmt || fmt.length < 16 || dataChunks.length === 0) {
    throw new Error('TTS provider WAV segment is missing fmt or data');
  }
  if (fmt.readUInt16LE(0) !== 1) {
    throw new Error('Long-form TTS requires uncompressed PCM WAV segments');
  }

  const byteRate = fmt.readUInt32LE(8);
  const blockAlign = fmt.readUInt16LE(12);
  const data = Buffer.concat(dataChunks);
  if (byteRate === 0 || blockAlign === 0 || data.length % blockAlign !== 0) {
    throw new Error('TTS provider returned malformed PCM WAV metadata');
  }

  return { fmt, data, byteRate, blockAlign };
}

export function concatenatePcmWavSegments(segments: readonly Uint8Array[]): { audio: Buffer; durationSec: number } {
  if (segments.length === 0) {
    throw new Error('Cannot concatenate an empty WAV segment list');
  }

  const parsed = segments.map(parsePcmWav);
  const first = parsed[0];
  for (const segment of parsed.slice(1)) {
    if (!segment.fmt.subarray(0, 16).equals(first.fmt.subarray(0, 16))) {
      throw new Error('TTS provider returned incompatible WAV segments');
    }
  }

  const data = Buffer.concat(parsed.map((segment) => segment.data));
  const fmtPadding = first.fmt.length % 2;
  const dataPadding = data.length % 2;
  const totalSize = 12 + 8 + first.fmt.length + fmtPadding + 8 + data.length + dataPadding;
  const output = Buffer.alloc(totalSize);

  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(totalSize - 8, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(first.fmt.length, 16);
  first.fmt.copy(output, 20);

  const dataChunkOffset = 20 + first.fmt.length + fmtPadding;
  output.write('data', dataChunkOffset, 'ascii');
  output.writeUInt32LE(data.length, dataChunkOffset + 4);
  data.copy(output, dataChunkOffset + 8);

  return {
    audio: output,
    durationSec: data.length / first.byteRate,
  };
}
