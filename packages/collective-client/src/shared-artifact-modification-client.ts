import { collectiveModificationProjectionSchema, contentTextEditSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import type { SharedArtifact, SharedArtifactOperation } from './collective-artifact-client.js';
import { readArtifactJsonPages } from './collective-artifact-client.js';

const proposal = z
  .object({
    proposalRef: z.string(),
    requestId: z.string(),
    revision: z.number().int().positive(),
    baseRevision: z.string(),
    resultRevision: z.string(),
    edits: contentTextEditSchema.array(),
    response: z.string(),
    authorCatId: z.string(),
  })
  .passthrough();
const previewSchema = z.object({
  request: collectiveModificationProjectionSchema,
  proposal,
  baseText: z.string().max(65536),
  proposedText: z.string().max(65536),
  stale: z.boolean(),
  currentOwnerRevision: z.number().int().positive(),
});
export type SharedArtifactModificationPreview = z.infer<typeof previewSchema>;
type Selection = { requestId: string; proposalRef: string };
type Operation = SharedArtifactOperation;

async function digest(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return `sha256:${Array.from(bytes, (item) => item.toString(16).padStart(2, '0')).join('')}`;
}
export async function previewSharedArtifactModification(
  operation: Operation,
  artifact: SharedArtifact,
  selection: Selection,
  resolveVersion = async (revision: number) => artifact.versions.find((version) => version.ownerRevision === revision),
) {
  const requestId = crypto.randomUUID();
  const value = previewSchema.parse(
    await readArtifactJsonPages((page) => operation(artifact, 'preview', { ...selection, ...page }, requestId)),
  );
  const version =
    artifact.versions.find((item) => item.ownerRevision === value.request.ownerRevision) ??
    (await resolveVersion(value.request.ownerRevision));
  if (
    value.request.requestId !== selection.requestId ||
    value.proposal.proposalRef !== selection.proposalRef ||
    value.proposal.requestId !== selection.requestId ||
    value.proposal.authorCatId !== value.request.target.catId ||
    value.request.sourceEventId !== artifact.sourceEventId ||
    value.request.location.channelId !== artifact.sourceLocation.channelId ||
    !version ||
    value.proposal.baseRevision !== version.blobDigest ||
    (await digest(value.baseText)) !== value.proposal.baseRevision ||
    (await digest(value.proposedText)) !== value.proposal.resultRevision
  )
    throw new Error('修改与这件作品的版本不一致，请重新读取。');
  return value;
}
export async function adoptSharedArtifactModification(
  operation: Operation,
  namespace: string,
  artifact: SharedArtifact,
  preview: SharedArtifactModificationPreview,
) {
  const selection = { requestId: preview.request.requestId, proposalRef: preview.proposal.proposalRef };
  const key = `collective-adoption:${namespace}:${artifact.artifactId}:${selection.requestId}:${selection.proposalRef}`;
  const requestId = localStorage.getItem(key) ?? crypto.randomUUID();
  localStorage.setItem(key, requestId);
  const result = z
    .object({
      state: z.literal('accepted'),
      receipt: z
        .object({
          contentRef: z.string(),
          ownerRevision: z.number(),
          previousOwnerRevision: z.number(),
          blobDigest: z.string(),
          receiptId: z.string(),
        })
        .passthrough(),
      lineage: z
        .object({
          requestId: z.string(),
          proposalRef: z.string(),
          requestEventId: z.string(),
          sourceEventId: z.string(),
          sourceOwnerRevision: z.number(),
        })
        .passthrough(),
    })
    .parse(await operation(artifact, 'apply', selection, requestId));
  if (
    result.receipt.contentRef !== artifact.contentRef ||
    result.receipt.previousOwnerRevision !== preview.request.ownerRevision ||
    result.receipt.ownerRevision !== preview.request.ownerRevision + 1 ||
    result.receipt.blobDigest !== preview.proposal.resultRevision ||
    result.lineage.requestId !== selection.requestId ||
    result.lineage.proposalRef !== selection.proposalRef ||
    result.lineage.requestEventId !== preview.request.requestEventId ||
    result.lineage.sourceEventId !== artifact.sourceEventId
  )
    throw new Error('采用回执尚未核对，请重试原操作。');
  return result;
}
