import { randomUUID } from 'node:crypto';
import { memoryReadRefSchema, type ReadRef } from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { handleDrillMemoryCue, handleGetMessage, handleReadProfile } from './callback-tools.js';
import { handleReadFileSlice, type ToolResult } from './file-tools.js';
import { handleReadMemoryMatter } from './matter-memory-tools.js';
import { canReadMemoryKind } from './memory-read-access.js';
import {
  failedOriginalRead,
  memoryReadFailure,
  projectMemoryRead,
  record,
  renderMemoryRead,
} from './memory-read-result.js';

const defineTool = defineMcpCanonicalFactory('read-memory-tools.ts', undefined, {
  resourceFamily: 'memory-read',
  authority: 'callback-owner',
});
export const readMemoryInputSchema = {
  ref: memoryReadRefSchema.describe(
    'Complete typed reading coordinate from a result/source/nextRef, or an already known exact address. Pass it unchanged.',
  ),
  agentKeyCatId: z
    .string()
    .min(1)
    .optional()
    .describe('Persistent-agent transport selector; ignored with invocation credentials. Never a target identity.'),
};
export async function handleReadMemory(input: { ref: ReadRef; agentKeyCatId?: string }): Promise<ToolResult> {
  let ref = memoryReadRefSchema.parse(input.ref);
  if (!canReadMemoryKind(ref.kind)) return memoryReadFailure(ref, 'read_kind_not_available_in_this_profile', false);
  if (ref.kind === 'profile') ref = { ...ref, requestId: ref.requestId ?? randomUUID() };
  if (ref.kind === 'cue') ref = { ...ref, clientRequestId: ref.clientRequestId ?? `memory-cue-drill-${randomUUID()}` };
  let result: ToolResult;
  switch (ref.kind) {
    case 'message':
      result = await handleGetMessage({
        messageId: ref.messageId,
        contextCount: ref.contextCount,
        mode: 'full',
        memoryRead: true,
        ...(ref.sourceSelection ? { sourceSelection: ref.sourceSelection } : {}),
        agentKeyCatId: input.agentKeyCatId,
      });
      break;
    case 'profile':
      result = await handleReadProfile({ ...ref, agentKeyCatId: input.agentKeyCatId });
      break;
    case 'matter':
      result = await handleReadMemoryMatter(ref);
      break;
    case 'cue':
      result = await handleDrillMemoryCue(ref);
      break;
    case 'file': {
      result = await handleReadFileSlice(ref, 'cat_cafe_read_memory');
      if (result.isError) return failedOriginalRead(ref, result);
      const meta = record(result.structuredContent);
      if (typeof meta.version !== 'string')
        return memoryReadFailure(ref, 'original_reader_missing_source_version', false);
      const nextRef = meta.nextRef as ReadRef | undefined;
      const header = renderMemoryRead({
        status: 'ok',
        ref: { ...ref, expectedRevision: String(meta.version) },
        contentKind: 'document',
        version: String(meta.version),
        data: { contentBlock: 1, format: 'line-numbered-text' },
        sources: [],
        sourcesStatus: 'not_provided',
        complete: meta.complete === true,
        ...(nextRef ? { nextRef } : {}),
      });
      // Keep the original plain-text domain body. JSON-escaping a long quoted line
      // would need extra pages even though the original reader returns it in one call.
      return { content: [...header.content, ...result.content] };
    }
  }
  if (result.isError) return failedOriginalRead(ref, result);
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(result.content[0]?.text ?? ''));
  } catch {
    return memoryReadFailure(ref, 'original_reader_returned_invalid_payload', true);
  }
  if (data.status === 'not_available')
    return memoryReadFailure(ref, String(data.reason ?? data.status), data.retryable === true);
  return projectMemoryRead(ref, data);
}
export const readMemoryTools = [
  defineTool({
    name: 'cat_cafe_read_memory',
    description:
      'Open an exact memory source with one typed ref. Use when a result, directory, cue, profile URI or source returns a reading coordinate; known coordinates work directly. ' +
      'NOT for finding sources, arbitrary tool execution, private person/time-window choices, raw sessions, pending-message delivery or adoption settlement. ' +
      'Output: original domain data, contentKind, actual version, complete sources and nextRef; pass nextRef unchanged to continue. Large JSON uses data.contentBlocks: concatenate those text blocks in this same response before parsing. ' +
      'Message contentRevision/sourceParts retain citation ownership; matter interpretation remains a cat summary and changed sources remain unverified. Read never publishes a card or records applied. ' +
      "GOTCHA: ref is an address, not authority. Each kind retains its original runtime/owner qualification. Profile cat-cafe-profile:// pointers use primer/corpus/capsule of this connection's authenticated identity; read the same layer before proposing replacement, reuse requestId on retry, and reread after revision conflict. Use the invocation-bound connection; a separate App cannot substitute. Cue handles retain owner/thread/invocation/expiry; retryRef preserves uncertain receipt keys. Unread/queued messages belong to get_thread_context.",
    inputSchema: readMemoryInputSchema,
    handler: handleReadMemory,
    governance: {
      implementationExport: 'handleReadMemory',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: [
        'full',
        'readonly',
        'agent-key',
        'desktop:fable-phase0',
        'desktop:cloud-pro-phase0',
        'desktop:live-companion',
      ],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'file:docs/architecture/memory/read-entry.md',
      },
    },
  }),
] as const;
