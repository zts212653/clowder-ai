import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

/** Keep one authorized input in memory across all parts; never copy it to API disk. */
export function readReferenceContent(source: string): { base64: string; sha256: string } | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(source, 'r');
    const buffer = Buffer.alloc(MAX_REFERENCE_BYTES + 1);
    let length = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
      if (length > MAX_REFERENCE_BYTES) return undefined;
    }
    if (length === 0) return undefined;
    const audio = buffer.subarray(0, length);
    return { base64: audio.toString('base64'), sha256: createHash('sha256').update(audio).digest('hex') };
  } catch {
    // This API's filesystem cannot establish whether another reader can use the path.
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Only explicit reader-bound content has a stable reference cache identity. */
export function referenceAudioCacheIdentity(_refAudio: string, sha256?: string): string {
  return sha256 ? `reference-reader-v4:${sha256}` : `reference-per-generation-v3:${randomUUID()}`;
}

export function independentAudioHash(expectedHash: string): string {
  return createHash('sha256').update(`${expectedHash}:${randomUUID()}`).digest('hex');
}
