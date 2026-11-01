import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { type CommitWork, MAX_HTML_WORK_BYTES, type WorkHtmlSource, type WorkReference } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { OpenWorkSource } from './service.js';

export function isHtmlWorkSource(source: CommitWork['source']): source is WorkHtmlSource {
  return 'kind' in source && source.kind === 'html';
}

/** The authenticated Work coordinator owns attribution. No file, message, renderer or network is consulted. */
export function openHtmlWorkSource(source: WorkHtmlSource): OpenWorkSource {
  const bytes = Buffer.from(source.html, 'utf8');
  const blobDigest = digest(bytes);
  return {
    mediaType: 'text/html',
    stream: Readable.from([bytes]),
    byteLength: bytes.length,
    blobDigest,
    publication: { artifactRef: 'inline-html', sourceRef: 'inline-html', revision: blobDigest },
    revalidate: async () => undefined,
  };
}

/** Only a previously authorized, bounded fixed HTML version may be materialized as text. */
export async function readHtmlWorkBody(
  owner: ProjectContentOwnerService,
  reference: WorkReference,
  description: { mediaType: string; byteLength: number; blobDigest: string },
) {
  if (description.mediaType !== 'text/html') throw new MediaOwnerError('invalid_media');
  if (description.byteLength < 1 || description.byteLength > MAX_HTML_WORK_BYTES)
    throw new MediaOwnerError('media_unavailable');
  const opened = await owner.open(reference.contentRef, reference.ownerRevision);
  const stream = opened.handle.createReadStream({ autoClose: false });
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > description.byteLength) throw new MediaOwnerError('media_unavailable');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (length !== description.byteLength || digest(bytes) !== description.blobDigest)
      throw new MediaOwnerError('media_unavailable');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new MediaOwnerError('media_unavailable');
    }
  } finally {
    stream.destroy();
    await opened.handle.close();
  }
}

function digest(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
