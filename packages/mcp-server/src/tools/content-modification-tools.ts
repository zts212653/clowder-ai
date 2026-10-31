import {
  contentModificationTakeoverSchema,
  inspectContentModificationSchema,
  respondContentTextSchema,
  videoProjectCommandSchema,
} from '@cat-cafe/shared';
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
    'Sorted non-overlapping UTF-16 [start,end) ranges in the original text, exact expectedText and replacement. Set optional selectionId only to an id from the request selections; omit it for an additional unscoped change, never infer it from overlap. Insertions use start=end. Every prior nonzero range must end before the next start; no guessed anchors.',
  ),
  response: respondContentTextSchema.shape.response.describe(
    'Named explanation of how this candidate addresses the human request; up to 8000 characters.',
  ),
};
export const takeOverContentModificationInputSchema = {
  ...contentModificationTakeoverSchema.shape,
  ...common,
  sourceMessageId: contentModificationTakeoverSchema.shape.sourceMessageId.describe(
    'Exact id of the delivered Human message addressed to this authenticated cat, carrying version-bound workspace-file quotes, canonical media attachments, or an immutable project-screening selection.',
  ),
  operationId: contentModificationTakeoverSchema.shape.operationId.describe(
    'Stable UUID for this takeover attempt. Retries must name the same source message and attachmentId. Competing addressed cats reuse the request for that same source selection.',
  ),
  attachmentId: contentModificationTakeoverSchema.shape.attachmentId.describe(
    'Optional exact id of one canonical media context_attachment in the delivered Human message. Required to select one work in a multi-source gallery send; never a filename, path, URL or selection id. Omit for legacy single-source text/media/project takeover.',
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
export function handleTakeOverContentModification(
  input: z.infer<z.ZodObject<typeof takeOverContentModificationInputSchema>>,
) {
  return post('take-over', input);
}
const admission = {
  disposition: 'accepted-boundary',
  kind: 'resource-entry',
  admissionRef: 'file:docs/architecture/f309-text-modification-contract.md',
} as const;
export const videoProjectCommandInputSchema = {
  requestId: videoProjectCommandSchema.shape.requestId.describe(
    'Exact accepted project requestId returned by take_over_content_modification, never a project URL or invented Task.',
  ),
  command: videoProjectCommandSchema.shape.command.describe(
    'read/review-read: copy nextCursor and snapshot until nextCursor is null, concatenate json chunks then parse. read ownerRevision is optional (current head) or an exact retained input revision. save: inline full JSON document (16 MiB limit), expectedOwnerRevision and stable operationId. review-act: exact ledger expectedRevision, operationId and an original annotationId. self-review: exact input, real segmentIds, conclusion and named evidence refs. No local file paths.',
  ),
};
export function handleVideoProjectCommand(input: z.infer<z.ZodObject<typeof videoProjectCommandInputSchema>>) {
  return callbackPost('/api/callbacks/video-project/command', input);
}
export const contentModificationTools = [
  defineTool({
    name: 'cat_cafe_video_project_command',
    description:
      'Read or modify the exact video project accepted from an original Human screening message. Use when: the named Cat has taken over a 审片意见 and needs the retained/current input, canonical意见/定位/经过, a CAS edit, or its own self-review attestation. Not for: creating a project or Task, Human decisions, media registration/rendering, unrelated opinions, arbitrary files, or agent-key impersonation. Output: read/review-read return bounded snapshot-fenced JSON pages; save/review-act/self-review persist to the existing F138 owner or F309 ledger and return actual receipts. Every command rechecks the real running child, original source audience/current rights, current bound Task and accepted journal receipt. GOTCHA: markers/drafts alone grant no write authority; read every JSON page before constructing a full-document save, and a self-review never implies Human approval.',
    inputSchema: videoProjectCommandInputSchema,
    handler: handleVideoProjectCommand,
    governance: {
      implementationExport: 'handleVideoProjectCommand',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'file:docs/architecture/f326-project-command-contract.md',
      },
    },
  }),
  defineTool({
    name: 'cat_cafe_take_over_content_modification',
    description:
      'Take over one delivered Human source selection as one durable modification request. Use when: the addressed Human asks this cat to modify exact-revision quotes from one file/base, a canonical image/video with places or a whole-work reference, or immutable project-screening marks. For a gallery message with multiple work sources, supply the exact attachmentId of the one media context_attachment to change; call separately for each requested work with a distinct operationId. Not for: batch Tasks, guessed first attachments, caller-supplied identities/body/anchors/paths, screenshots as identity, unversioned sources, recalled messages, DOCX changes, Human acceptance or writing the original file. Output: the existing owner-authorized request/Task/execution state and server selection-to-annotation ids. The server rereads the original Human, exact work/version and current rights; competing addressed cats reuse the same source-selection request. A retry UUID cannot select a different attachment. Omit attachmentId only for compatible single-source calls; ambiguous multi-source messages are refused. Use read_artifact_review/respond_artifact_review for media content/candidates, or video_project_command for accepted project marks. Project takeover still requires a real invocation that consumed the source; this tool never resends the Human message.',
    inputSchema: takeOverContentModificationInputSchema,
    handler: handleTakeOverContentModification,
    governance: {
      implementationExport: 'handleTakeOverContentModification',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
      standaloneReason: { ...admission, admissionRef: 'file:docs/architecture/f309-media-message-contract.md' },
    },
  }),
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
