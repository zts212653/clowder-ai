import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { findMessageSticker, messageStickerReference } from '@cat-cafe/shared';
import { authorizedAttachmentStream } from './message-attachment-stream.js';

/** Artwork stays in its original Host. Only the approved Service's current members receive catalogue bytes. */
export type MessageStickerDirectories = Readonly<Record<'memory' | 'collaboration', string>>;

export async function openMessageSticker(
  directories: MessageStickerDirectories,
  stickerId: string,
  authorize: () => Promise<void>,
  signal: AbortSignal,
) {
  const entry = findMessageSticker(stickerId);
  if (!entry) throw new Error('Unknown sticker catalogue image');
  await authorize();
  const bytes = await readFile(join(directories[entry.source], entry.assetFile));
  if (
    bytes.length !== entry.byteLength ||
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== entry.blobDigest
  )
    throw new Error('Sticker catalogue bytes do not match their immutable revision');
  await authorize();
  return {
    sticker: messageStickerReference(entry.id),
    body: authorizedAttachmentStream(Readable.from([bytes]), authorize, signal),
  };
}
