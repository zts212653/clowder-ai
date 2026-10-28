import { workCommandSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import { deliverWorkReference } from './work-reference-delivery.js';

const defineTool = defineMcpCanonicalFactory('work-tools.ts', undefined, {
  resourceFamily: 'collaborative-content',
  authority: 'callback-thread',
});
// These locator-sized calls can freeze, probe and commit a large local video before replying.
// A short generic callback timeout would repeat that work while the first owner effect is still running.
const LOCAL_FILE_ACTIONS = new Set(['inspect-source', 'create', 'submit', 'import-context', 'index-asset']);
const LOCAL_FILE_TRANSPORT = { fetchTimeoutMs: 180_000, retryDelaysMs: [], enableOutbox: false };
export const workCommandInputSchema = {
  contentTaskId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Original F309 publication-modification Task ID when reading or submitting entrusted content. Context only: the live Task owner, exact content grant and original Human source are rechecked. Never create a Task merely to import your own work.',
    ),
  command: workCommandSchema.describe(
    'inspect-source resolves a registered Workspace MP4 locator to its exact digest. create saves a new work; submit uses the same contentRef, expectedOwnerRevision, new source and changeSummary. Optional submit.reviewResponse attaches responses to an original reviewId/sourceRound with current review/Task CAS, requestId when present, and per-opinion explanations. If the source round has ledgerRef, also copy that round’s ledgerRevision into expectedLedgerRevision; it is separate from the review revision. resultAnchor uses the inspected NEW source clock; omit it when unmapped. This produces one owner version and its original review projection, never Human acceptance. Reuse operationId only for the identical complete intent, including responses; after version_saved retry that exact command, never publish another version. Large-file operations wait up to 180 seconds without automatic HTTP retries. An unconfirmed result may already be saved: read/list first, then retry the identical operation only if needed. resolve-review-submission is direct-Human-only, not a cat action. read requires fixed {contentRef,ownerRevision}; list discovers retained versions. publish-reference alone attaches the fixed-version card to the current message, without resubmitting bytes. set-context saves a small video index with expectedMetadataRevision CAS; import-context reads a complete video index from a registered F063 JSON locator + expectedSourceRevision (UTF-8, maximum 2 MiB), preserving the 32 KiB command limit. read-context reads the current or a fixed metadata revision. Replays retain the original index even if its source file was removed. Indexing never publishes a film version. Asset commands share this owner surface: index-asset verifies an exact workspace version; list-assets defaults to purpose=select and returns only verified current canonical assets. purpose=used requires a fixed WorkReference and retains every original item, including failed, replaced and missing ones. read-asset with expectedRevision rechecks a selection before use; read-asset-history preserves judgments and supersessions. set-asset-status and supersede-asset require CAS, reason and stable operationId; set-asset-status may include explicit applicability to register or correct candidate purposes even after a file was indexed; all affected use bindings need explicit atomic dispositions. bind-character-asset and decide-asset-update are direct-Human-only; cats may read them but cannot select global identities or record keep decisions. Preserve bindingRef+bindingRevision+indexedVersionRef in set-context/import-context assets[].bindingSelection when production uses a selected character asset. check-asset-updates reports exact original uses without changing films or creating Tasks. Never treat an empty canonical selection as permission to use experimental samples. This video index import does not admit HTML/PPT/body input; each format keeps its own boundary.',
  ),
  cursor: z
    .number()
    .int()
    .min(0)
    .max(16 * 1024 * 1024)
    .default(0)
    .describe('Copy nextCursor with the unchanged command and expectedSnapshot; join json chunks before parsing.'),
  expectedSnapshot: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional()
    .describe('Copy snapshot for every continuation page. A changed result is rejected.'),
};
export function handleWorkCommand(input: z.infer<z.ZodObject<typeof workCommandInputSchema>>) {
  if (input.command.action === 'publish-reference') return deliverWorkReference({ ...input, command: input.command });
  return callbackPost(
    '/api/callbacks/work',
    input,
    LOCAL_FILE_ACTIONS.has(input.command.action) ? LOCAL_FILE_TRANSPORT : undefined,
  );
}
export const workTools = [
  defineTool({
    name: 'cat_cafe_work',
    description:
      'Save a work or explicitly submit its next version to the shared content owner. Use when: finding current canonical production assets or inspecting a film’s original materials, recording an authorized asset judgment, delivering a completed video, reading a fixed work version, responding to original review opinions while submitting that same next version, finding an interrupted submission, or publishing its fixed-version chat card. Not for: rendering, arbitrary host paths, changing another author’s work without a current grant, accepting Human opinions, or treating a filename/widget block as work identity. Output: create/submit persist immutable bytes and a CAS/idempotency receipt with contentRef + ownerRevision and stay silent in chat; publish-reference alone attaches the exact owner card to the current message. Other actions return snapshot-fenced JSON-text pages: join every json chunk and reuse the unchanged command/operationId for continuation. GOTCHA: a saved version and an attached card are separate effects; retry an unconfirmed card with its original reference, never by submitting another version. Current invocation and source-root permissions are rechecked; source messages and self-reported directors are not grants.',
    inputSchema: workCommandInputSchema,
    handler: handleWorkCommand,
    governance: {
      implementationExport: 'handleWorkCommand',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'file:docs/architecture/f309-living-work-entry-contract.md',
      },
    },
  }),
];
