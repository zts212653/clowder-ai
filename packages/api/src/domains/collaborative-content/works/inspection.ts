import { createHash } from 'node:crypto';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';

/** Snapshot-fenced JSON transport, shared by reads and replayable commit receipts. No field is silently clipped. */
export function inspectWorkResult(input: { cursor: number; expectedSnapshot?: string }, result: unknown) {
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > 16 * 1024 * 1024) throw new MediaOwnerError('media_unavailable');
  const snapshot = `sha256:${createHash('sha256').update(json).digest('hex')}`;
  if ((input.cursor > 0 && !input.expectedSnapshot) || (input.expectedSnapshot && input.expectedSnapshot !== snapshot))
    throw new MediaOwnerError('publication_changed');
  if (input.cursor > json.length) throw new MediaOwnerError('not_found');
  let end = Math.min(json.length, input.cursor + 6000);
  const page = () => ({
    encoding: 'json-text-chunk',
    snapshot,
    json: json.slice(input.cursor, end),
    nextCursor: end < json.length ? end : null,
  });
  while (JSON.stringify(page()).length > 12000 && end > input.cursor) end -= 256;
  return page();
}
