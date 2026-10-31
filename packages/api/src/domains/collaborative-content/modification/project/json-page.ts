import { createHash } from 'node:crypto';
import { WorkspaceContentSourceError } from '../../../workspace/workspace-content-source.js';
import { ModificationTextError } from '../text/text-store.js';
/** Concatenate every JSON-text page before parsing; a changed snapshot never silently splices versions. */
export function projectCommandJsonPage(
  requestId: string,
  section: string,
  input: { cursor: number; expectedSnapshot?: string },
  value: unknown,
) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024 * 1024) throw new WorkspaceContentSourceError('too_large');
  const snapshot = `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
  if ((input.cursor > 0 && !input.expectedSnapshot) || (input.expectedSnapshot && input.expectedSnapshot !== snapshot))
    throw new ModificationTextError('proposal_changed');
  if (input.cursor > serialized.length) throw new ModificationTextError('not_found');
  let end = Math.min(serialized.length, input.cursor + 6000);
  const result = () => ({
    requestId,
    section,
    snapshot,
    encoding: 'json-text-chunk',
    json: serialized.slice(input.cursor, end),
    nextCursor: end < serialized.length ? end : null,
  });
  while (JSON.stringify(result()).length > 12000 && end > input.cursor) end -= 256;
  return result();
}
