import { inspectContentModificationSchema, respondContentTextSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';

const defineTool = defineMcpCanonicalFactory('content-modification-tools.ts', undefined, {
  resourceFamily: 'collaborative-content',
  authority: 'callback-thread',
});
const common = {
  threadId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Omit for invocation auth; explicit permitted execution thread for agent-key auth.'),
  agentKeyCatId: z
    .string()
    .min(1)
    .optional()
    .describe('Persistent-agent identity selector; omit with invocation auth.'),
};
export const readContentModificationInputSchema = {
  ...inspectContentModificationSchema.shape,
  ...common,
  requestId: inspectContentModificationSchema.shape.requestId.describe(
    'Exact requestId from the Host text-modification return.',
  ),
  view: inspectContentModificationSchema.shape.view.describe(
    'control: content-free request state for text or media; overview: text request, Task revision, execution files; source: immutable original text; proposals: named patch history.',
  ),
  reviewId: inspectContentModificationSchema.shape.reviewId.describe(
    'For a media control read, copy the exact reviewId from the same request envelope; a different review is rejected. Only valid with view=control.',
  ),
  cursor: inspectContentModificationSchema.shape.cursor.describe(
    'Copy nextCursor; concatenate json chunks in order and parse as JSON to recover every field without truncation.',
  ),
  expectedSnapshot: inspectContentModificationSchema.shape.expectedSnapshot.describe(
    'Copy snapshot on every later page; changing owner facts reject stale pagination.',
  ),
};
export const respondContentModificationInputSchema = {
  ...respondContentTextSchema.shape,
  ...common,
  requestId: respondContentTextSchema.shape.requestId.describe('Exact requestId read from the accepted human request.'),
  operationId: respondContentTextSchema.shape.operationId.describe(
    'UUID for this patch response. Retry identical payload with the same UUID.',
  ),
  expectedTaskRevision: respondContentTextSchema.shape.expectedTaskRevision.describe(
    'Current entrusted-work contract revision from the authorized read.',
  ),
  expectedProposalRevision: respondContentTextSchema.shape.expectedProposalRevision.describe(
    'Latest proposal revision, or 0 for the first response.',
  ),
  baseRevision: respondContentTextSchema.shape.baseRevision.describe(
    'Exact sha256: digest of the immutable original text. Edits always address this base, not the mutable original file.',
  ),
  edits: respondContentTextSchema.shape.edits.describe(
    'Sorted non-overlapping UTF-16 [start,end) ranges in the original text, exact expectedText and replacement. Insertions use start=end. Every prior nonzero range must end before the next start; no guessed anchors.',
  ),
  response: respondContentTextSchema.shape.response.describe(
    'Named explanation of how this candidate addresses the human request; up to 8000 characters.',
  ),
};
function post(operation: string, input: { agentKeyCatId?: string }) {
  const { agentKeyCatId, ...body } = input;
  return callbackPost(`/api/callbacks/content-modification/${operation}`, body, { agentKeyCatId });
}
export function handleReadContentModification(input: z.infer<z.ZodObject<typeof readContentModificationInputSchema>>) {
  return post('read', input);
}
export function handleRespondContentModification(
  input: z.infer<z.ZodObject<typeof respondContentModificationInputSchema>>,
) {
  return post('respond', input);
}
const admission = {
  disposition: 'accepted-boundary',
  kind: 'resource-entry',
  admissionRef: 'file:docs/architecture/f309-text-modification-contract.md',
} as const;
export const contentModificationTools = [
  defineTool({
    name: 'cat_cafe_read_content_modification',
    description:
      'Read an accepted modification request: content-free control state for text/media, or the immutable F063 text source, patch history and isolated execution copy. Use when: a Host request asks its named Task owner to 核对取消/来源状态 or 修改文本/代码 and return a diff. Not for: creating Tasks, arbitrary files, image/video content (use read_artifact_review), or accepting a result. Output: independently snapshot-fenced JSON pages with request state and human rejection receipts; concatenate json chunks then parse JSON. Media callers use view=control with the envelope requestId/reviewId. Control reads require the current bound Task owner, expose no intent text, and remain readable after source recall; source_unavailable/cancelled ends this request only. Text source copies stay in the isolated directory. Rejection is history, not a new entrustment. Reading is not a response or file writeback.',
    inputSchema: readContentModificationInputSchema,
    handler: handleReadContentModification,
    governance: {
      implementationExport: 'handleReadContentModification',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'readonly', 'agent-key'],
      standaloneReason: admission,
    },
  }),
  defineTool({
    name: 'cat_cafe_respond_content_modification',
    description:
      'Return a named, base-revision-bound text patch for an accepted modification request. Use when: the Task owner has prepared a Markdown/code/text candidate in isolation and can explain the edits. Not for: writing the original workspace file, DOCX native tracked changes, PNG/MP4 versions (use respond_artifact_review), human acceptance, or Task closure. Output: durable idempotent proposal/receipt and isolated candidate file; the user sees a diff and separately accepts F063 CAS writeback. A candidate receipt proves a returned proposal, never that the original file changed.',
    inputSchema: respondContentModificationInputSchema,
    handler: handleRespondContentModification,
    governance: {
      implementationExport: 'handleRespondContentModification',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
      standaloneReason: admission,
    },
  }),
] as const;
