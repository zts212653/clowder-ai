import { createHash } from 'node:crypto';
import { type MemoryReadEnvelope, memoryReadRefSchema, type ReadRef } from '@cat-cafe/shared';
import { readProfileOpeningReference } from '@cat-cafe/shared/profile-opening-reference';
import type { ToolResult } from './file-tools.js';

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function messageSource(value: unknown): ReadRef[] {
  const source = record(value);
  const parsed = memoryReadRefSchema.safeParse({
    kind: 'message',
    threadId: source.threadId,
    messageId: source.messageId,
    ...(typeof source.contentRevision === 'string' ? { expectedRevision: source.contentRevision } : {}),
    ...(source.segment && typeof source.sourceRevision === 'string'
      ? {
          sourceSelection: {
            segment: source.segment,
            start: source.start,
            end: source.end,
            expectedRevision: source.sourceRevision,
            ...(source.contentBlockIndex !== undefined ? { contentBlockIndex: source.contentBlockIndex } : {}),
            ...(source.attachmentId !== undefined ? { attachmentId: source.attachmentId } : {}),
          },
        }
      : {}),
  });
  return parsed.success ? [parsed.data] : [];
}
export function memoryReadSources(data: Record<string, unknown>, kind: ReadRef['kind']): ReadRef[] {
  const payload = kind === 'cue' ? record(data.payload) : data;
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const sources = entries.flatMap((entry) => {
    const parsed = memoryReadRefSchema.safeParse(record(entry).readRef);
    return parsed.success ? [parsed.data] : messageSource(record(entry).source);
  });
  sources.push(...messageSource(payload.source));
  if (Array.isArray(payload.sources)) sources.push(...payload.sources.flatMap(messageSource));
  // Person-card summaries cap top-level provenance separately from each returned fact.
  const provenanceHolders = [payload, ...(Array.isArray(payload.facts) ? payload.facts.map(record) : [])];
  for (const holder of provenanceHolders)
    if (Array.isArray(holder.provenanceRefs)) sources.push(...holder.provenanceRefs.flatMap(messageSource));
  if (Array.isArray(payload.excerpts))
    sources.push(...payload.excerpts.flatMap((item) => messageSource(record(item).source)));
  if ((kind === 'profile' || typeof payload.profileUri === 'string') && typeof payload.content === 'string') {
    const opening = readProfileOpeningReference(payload.content);
    if (opening) sources.push(...opening.excerpts.flatMap((item) => messageSource(item.source)));
  }
  return [...new Map(sources.map((source) => [JSON.stringify(source), source])).values()];
}
export function memoryReadVersion(ref: ReadRef, data: Record<string, unknown>): string | number | undefined {
  const known =
    ref.kind === 'message'
      ? record(data.message).contentRevision
      : ref.kind === 'matter'
        ? record(data.matter).revision
        : ref.kind === 'cue'
          ? record(data.source).revision
          : data.revision;
  if (typeof known === 'string' || typeof known === 'number') return known;
  // Readable system/approval originals intentionally have no message citation license.
  return ref.kind === 'message' ? payloadRevision(data) : undefined;
}
function payloadRevision(data: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(data)).digest('hex')}`;
}
export function memoryReadFailure(ref: ReadRef, reason: string, retryable: boolean, changed = false): ToolResult {
  return renderMemoryRead(
    {
      status: changed ? 'source_changed' : 'not_available',
      ref,
      contentKind: contentKind(ref, {}),
      sources: [],
      sourcesStatus: 'not_provided',
      complete: false,
      error: { reason, retryable },
      ...(retryable ? { retryRef: ref } : {}),
    },
    true,
  );
}
export function failedOriginalRead(ref: ReadRef, result: ToolResult): ToolResult {
  const reason = result.content.map((part) => part.text).join('\n');
  const status = Number(/Callback failed \((\d{3})\)/.exec(reason)?.[1]);
  const changed =
    /profile_revision_changed|stale_revision|source_corrected|source_revision_changed|invalid_cursor/.test(reason);
  const terminalLocal = /Access denied|File not found|Invalid |Not a file|Line range|exceeds.*budget/.test(reason);
  return memoryReadFailure(
    ref,
    reason,
    !changed && !terminalLocal && (!status || status >= 500 || status === 408 || status === 429),
    changed,
  );
}
function contentKind(ref: ReadRef, data: Record<string, unknown>): MemoryReadEnvelope['contentKind'] {
  if (ref.kind === 'message') return 'original_message';
  if (ref.kind === 'file') return 'document';
  if (ref.kind === 'profile') return 'approved_view';
  if (ref.kind === 'matter') {
    const entries = Array.isArray(data.entries) ? data.entries : [];
    return entries.length && entries.every((entry) => record(entry).summary && record(record(entry).source).kind)
      ? 'cat_summary'
      : 'mixed';
  }
  const payload = record(data.payload);
  if (payload.matter) return 'mixed';
  if (payload.message) return 'original_message';
  if (payload.sourcePath) return 'document';
  if (payload.profileUri) return 'approved_view';
  return 'cat_summary';
}
function pin(ref: ReadRef, version: string | number): ReadRef {
  return memoryReadRefSchema.parse({ ...ref, expectedRevision: version });
}
export function projectMemoryRead(ref: ReadRef, data: Record<string, unknown>): ToolResult {
  const version = memoryReadVersion(ref, data);
  if (version === undefined) return memoryReadFailure(ref, 'original_reader_missing_source_version', false);
  if (ref.expectedRevision !== undefined && ref.expectedRevision !== version)
    return memoryReadFailure(
      ref,
      'source_revision_changed; start a fresh read without the stale expectedRevision',
      false,
      true,
    );
  if (ref.kind === 'message' && ref.threadId !== undefined && ref.threadId !== record(data.message).threadId)
    return memoryReadFailure(ref, 'source_thread_mismatch', false);
  const pinned = pin(ref, version);
  const sources = memoryReadSources(data, ref.kind);
  const sourcePayload = ref.kind === 'cue' ? record(data.payload) : data;
  const sourceThreads = [
    ...new Map(
      (Array.isArray(sourcePayload.entries) ? sourcePayload.entries : []).flatMap((entry) => {
        const source = record(record(entry).source);
        return source.kind === 'thread' && typeof source.threadId === 'string'
          ? [[source.threadId, { threadId: source.threadId }] as const]
          : [];
      }),
    ).values(),
  ];
  let nextRef: ReadRef | undefined;
  if (ref.kind === 'matter' && typeof data.nextCursor === 'string')
    nextRef = { ...pinned, cursor: data.nextCursor } as ReadRef;
  const payload = record(data.payload);
  if (ref.kind === 'cue' && typeof payload.nextOffset === 'number') {
    nextRef = {
      ...pinned,
      kind: 'cue',
      handle: ref.handle,
      window: { offset: payload.nextOffset },
      clientRequestId: undefined,
    } as ReadRef;
  }
  return renderMemoryRead({
    status: data.summaryStatus === 'sources_changed' ? 'source_changed' : 'ok',
    ref: pinned,
    contentKind: contentKind(ref, data),
    version,
    data,
    sources,
    ...(sourceThreads.length ? { sourceThreads } : {}),
    sourcesStatus: sources.length || sourceThreads.length ? 'available' : 'not_provided',
    complete: !nextRef,
    ...(nextRef ? { nextRef } : {}),
  });
}

const MAX_RESPONSE_CHARS = 23_000;
/** Preserve the original call count: all long-domain blocks travel in this same response. */
export function renderMemoryRead(envelope: MemoryReadEnvelope, isError = false): ToolResult {
  const text = JSON.stringify(envelope);
  if (text.length <= MAX_RESPONSE_CHARS || envelope.data === undefined)
    return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
  const serialized = JSON.stringify(envelope.data);
  const blocks: ToolResult['content'] = [];
  for (let start = 0; start < serialized.length; ) {
    let end = Math.min(start + 12_000, serialized.length);
    const last = serialized.charCodeAt(end - 1);
    if (end < serialized.length && last >= 0xd800 && last <= 0xdbff) end--;
    blocks.push({ type: 'text', text: serialized.slice(start, end) });
    start = end;
  }
  const header = { ...envelope, data: { encoding: 'json', contentBlocks: blocks.map((_, index) => index + 1) } };
  return {
    content: [{ type: 'text', text: JSON.stringify(header) }, ...blocks],
    ...(isError ? { isError: true } : {}),
  };
}
