import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';

export const MAX_STREAM_CONTENT_BYTES = 2 * 1024 * 1024 * 1024;

export interface ContentStream {
  readonly stream: Readable;
  readonly byteLength: number;
  readonly blobDigest: `sha256:${string}`;
  readonly signal?: AbortSignal;
}

export function validateContentStream(input: ContentStream) {
  if (
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 1 ||
    input.byteLength > MAX_STREAM_CONTENT_BYTES ||
    !/^sha256:[a-f0-9]{64}$/.test(input.blobDigest)
  )
    throw new TypeError('Invalid streamed content bounds');
  input.signal?.throwIfAborted();
}

/** Private temp-file writer. The caller publishes no manifest until every byte is verified. */
export async function writeOwnerPayload(handle: FileHandle, payload: Uint8Array | ContentStream) {
  if (payload instanceof Uint8Array) {
    await handle.writeFile(payload);
    return;
  }
  validateContentStream(payload);
  const hash = createHash('sha256');
  let length = 0;
  for await (const chunk of payload.stream) {
    payload.signal?.throwIfAborted();
    if (!(chunk instanceof Uint8Array)) throw new TypeError('Content stream must contain bytes');
    length += chunk.byteLength;
    if (length > payload.byteLength) throw new Error('Content stream length mismatch');
    hash.update(chunk);
    await handle.writeFile(chunk);
  }
  payload.signal?.throwIfAborted();
  if (length !== payload.byteLength || `sha256:${hash.digest('hex')}` !== payload.blobDigest)
    throw new Error('Content stream digest or length mismatch');
}
