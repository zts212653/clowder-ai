import {
  MAX_HTML_WORK_VERSIONS,
  type WorkReference,
  workHtmlSourceSchema,
  workReferenceSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';

const metadata = z.object({
  reference: workReferenceSchema,
  currentOwnerRevision: z.number().int().positive().safe(),
  description: z.object({ mediaType: z.string() }).passthrough(),
  version: z.object({ title: z.string().min(1).max(240) }),
});
const body = z.object({
  reference: workReferenceSchema,
  mediaType: z.literal('text/html'),
  html: workHtmlSourceSchema.shape.html,
});
export type Content = { kind: 'media' } | { kind: 'html'; html: string; title: string; latest: number };
export class Unavailable extends Error {}

function exact(actual: WorkReference, expected: WorkReference) {
  if (actual.contentRef !== expected.contentRef || actual.ownerRevision !== expected.ownerRevision)
    throw new Error('Owner returned a different fixed version');
}
async function command(action: 'read' | 'read-body', reference: WorkReference, threadId: string, signal: AbortSignal) {
  const response = await apiFetch('/api/works/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      threadId,
      command: { action, reference: { contentRef: reference.contentRef, ownerRevision: reference.ownerRevision } },
    }),
    signal,
  });
  if ([401, 403, 404].includes(response.status)) throw new Unavailable();
  if (!response.ok) throw new Error('Owner version read failed');
  return response.json();
}

export async function readWorkMetadata(reference: WorkReference, threadId: string, signal: AbortSignal) {
  const info = metadata.parse(await command('read', reference, threadId, signal));
  exact(info.reference, reference);
  if (info.currentOwnerRevision < reference.ownerRevision) throw new Error('Invalid owner head');
  return info;
}
export async function readWorkContent(
  reference: WorkReference,
  threadId: string,
  signal: AbortSignal,
): Promise<Content> {
  const info = await readWorkMetadata(reference, threadId, signal);
  if (info.description.mediaType === 'video/mp4') return { kind: 'media' };
  if (info.description.mediaType !== 'text/html' || info.currentOwnerRevision > MAX_HTML_WORK_VERSIONS)
    throw new Error('Unsupported work format');
  const fixed = body.parse(await command('read-body', reference, threadId, signal));
  exact(fixed.reference, reference);
  return { kind: 'html', html: fixed.html, title: info.version.title, latest: info.currentOwnerRevision };
}
