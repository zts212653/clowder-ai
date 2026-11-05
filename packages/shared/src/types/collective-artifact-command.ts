import { z } from 'zod';
import { collectiveArtifactReadPageSchema } from './collective-artifact-operations.js';
import { respondCollectiveContentTextSchema } from './collective-content-modification.js';

const artifactId = z
  .string()
  .min(1)
  .max(256)
  .describe('Exact artifactId from current-context artifactRequests for this invocation source.');
export const collectiveArtifactCommandSchema = z.discriminatedUnion('kind', [
  collectiveArtifactReadPageSchema.extend({ kind: z.literal('read'), artifactId }).strict(),
  respondCollectiveContentTextSchema.extend({ kind: z.literal('respond'), artifactId }).strict(),
]);
export type CollectiveArtifactCommand = z.infer<typeof collectiveArtifactCommandSchema>;
export const collectiveArtifactCallbackCommandSchema = z
  .object({
    contextRef: z
      .string()
      .min(1)
      .max(256)
      .describe('Opaque contextRef issued by current-context in this authenticated invocation.'),
    command: collectiveArtifactCommandSchema.describe(
      'read returns the pinned owner source, selected annotations, canonical requestId and latestProposalRevision. Read every JSON page using nextCursor and expectedSnapshot before editing. respond uses that requestId, expectedOwnerRevision, exact baseRevision, next proposal CAS and a stable operation UUID; edits are sorted UTF-16 [start,end) ranges with exact expectedText/replacement. respond returns a proposal receipt with exact ref/digests/author, without echoing edits or response; Humans read the complete owner-backed preview before deciding. No apply command is available to Cats.',
    ),
  })
  .strict();
