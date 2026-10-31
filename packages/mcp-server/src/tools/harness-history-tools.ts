import { harnessHistoryPublicationCommandSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackGet, callbackPost } from './callback-tools.js';

const defineTool = defineMcpCanonicalFactory('harness-history-tools.ts', undefined, {
  resourceFamily: 'harness-history',
  authority: 'callback-owner',
});
const admissionReason = {
  disposition: 'accepted-boundary' as const,
  kind: 'resource-entry' as const,
  admissionRef: 'architecture-cell:capability-evolution-control' as const,
};
const programId = z
  .string()
  .regex(/^evolution-program:[0-9a-f]{32}$/)
  .describe('Existing development-process Evolution Program id; never create a new Program to publish history.');
export const getHarnessHistoryInputSchema = { programId };
export const publishHarnessHistoryInputSchema = {
  programId,
  command: harnessHistoryPublicationCommandSchema.describe(
    'publish: exact 40-hex sourceRevision already on canonical main; restore: prior successful restoreRevision or 0 for the bundled baseline. Both require current expectedRevision, stable clientMessageId and a readable reason.',
  ),
};
const getCommand = z.object(getHarnessHistoryInputSchema).strict();
const publishCommand = z.object(publishHarnessHistoryInputSchema).strict();
export function handleGetHarnessHistory(raw: z.infer<typeof getCommand>) {
  const input = getCommand.parse(raw);
  return callbackGet(`/api/callbacks/harness-history/programs/${encodeURIComponent(input.programId)}`);
}
export function handlePublishHarnessHistory(raw: z.infer<typeof publishCommand>) {
  const input = publishCommand.parse(raw);
  return callbackPost(
    `/api/callbacks/harness-history/programs/${encodeURIComponent(input.programId)}/publications`,
    input.command,
  );
}
export const harnessHistoryTools = [
  defineTool({
    name: 'cat_cafe_get_harness_history',
    description:
      'Read the published development-history source and named publication attempts for an existing Evolution Program. ' +
      'Use when: checking which 错题谱系稿 is live, its current revision, a failed update, or a restore target before publishing. ' +
      'NOT for: editing archive text, reading arbitrary Git commits, creating a Program, adopting a candidate, or proving runtime deployment. ' +
      'Output: current immutable content source, publication revision and the latest 50 durable attempts; no writes. ' +
      'GOTCHA: content publication revision is independent of runtime HEAD and of the original case-evidence snapshot.',
    inputSchema: getHarnessHistoryInputSchema,
    handler: handleGetHarnessHistory,
    governance: {
      implementationExport: 'handleGetHarnessHistory',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: admissionReason,
    },
  }),
  defineTool({
    name: 'cat_cafe_publish_harness_history',
    description:
      'Publish or restore an immutable development-history draft for an existing Evolution Program without restarting its runtime. ' +
      'Use when: a source-backed 错题谱系 update is committed on canonical main and should become visible, or an existing successful draft should be restored. ' +
      'NOT for: editing files, arbitrary repositories or paths, Program stage/adoption changes, candidate approval, or browser/agent-key writes. ' +
      'Output: a durable named attempt; success switches the content pointer, validation failure preserves the previous draft, and restore appends a new receipt. ' +
      'GOTCHA: read the current revision first; retry the identical command with the same clientMessageId after interruption. The first API/renderer installation still needs deployment; subsequent content updates do not.',
    inputSchema: publishHarnessHistoryInputSchema,
    handler: handlePublishHarnessHistory,
    governance: {
      implementationExport: 'handlePublishHarnessHistory',
      action: 'publish',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: admissionReason,
    },
  }),
] as const;
