import {
  type CollectiveDocumentTarget,
  type CollectiveDocumentView as SharedMarkdownView,
  collectiveDocumentViewSchema as sharedMarkdownViewSchema,
} from '@cat-cafe/shared';
import { projectArtifactClient } from './project-artifact-client.js';
import { readArtifactJsonPages, SharedArtifactCatalogueReconciled } from './shared-artifact-json-pages.js';
export { readArtifactJsonPages, SharedArtifactCatalogueReconciled };

import {
  type CollectiveArtifactAction,
  type CollectiveModificationProjection,
  collectiveArtifactProjectionSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { ClientRequest } from './client-request.js';
import { appendSharedAnnotationPage, assertSharedAnnotationPage } from './shared-artifact-annotation-pages.js';
import { resolveSharedArtifactModification } from './shared-artifact-control-client.js';
import { sendSharedArtifactFeedback } from './shared-artifact-feedback-client.js';
import { sharedArtifactHistoryClient } from './shared-artifact-history-client.js';
import { sharedArtifactManagementClient } from './shared-artifact-management-client.js';
import {
  adoptSharedArtifactModification,
  previewSharedArtifactModification,
  type SharedArtifactModificationPreview,
} from './shared-artifact-modification-client.js';
import {
  sendSharedAnnotationReply,
  setSharedAnnotationState,
  verifySharedAnnotationReplyPage,
} from './shared-artifact-review-client.js';

export interface SharedArtifactOpenOptions {
  projectReturn?: CollectiveDocumentTarget['projectReturn'];
  comparisonOwnerRevision?: number;
  discussionOnly?: boolean;
}
export type SharedArtifact = z.infer<typeof collectiveArtifactProjectionSchema>;
const workResultArtifactResolutionSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('published'),
      mayPromote: z.literal(false),
      artifact: collectiveArtifactProjectionSchema,
    })
    .strict(),
  z
    .object({
      status: z.enum(['unpublished', 'pending']),
      mayPromote: z.boolean(),
    })
    .strict(),
]);
export type SharedArtifactOperation = (
  artifact: SharedArtifact,
  action: CollectiveArtifactAction,
  payload: Record<string, unknown>,
  requestId: string,
  ownerRevision?: number,
) => Promise<unknown>;
export type { CollectiveDocumentView as SharedMarkdownView } from '@cat-cafe/shared';
export { collectiveDocumentViewSchema as sharedMarkdownViewSchema } from '@cat-cafe/shared';

type Coordinates = { serviceInstanceId: string; collectiveId: string };

/** This factory retains one authenticated coordinate binding; mutation clients are split out, while shared page/schema assembly stays here to avoid cyclic imports.
 * Shared Service coordinates only; the current Human bearer stays inside the existing request transport. */
export function collectiveArtifactClient(request: ClientRequest, coordinates: Coordinates, namespace: string) {
  const post = <T>(path: string, body: unknown) =>
    request<T>(`/api/artifacts/${path}`, { method: 'POST', body: JSON.stringify(body) });
  const historyClient = sharedArtifactHistoryClient(post, coordinates);
  const list = async () => {
    const artifacts = z
      .object({ artifacts: z.array(collectiveArtifactProjectionSchema) })
      .parse(await post('list', coordinates)).artifacts;
    if (
      artifacts.some(
        (artifact) =>
          artifact.serviceInstanceId !== coordinates.serviceInstanceId ||
          artifact.collectiveId !== coordinates.collectiveId,
      )
    )
      throw new Error('作品列表已改变，请重新读取。');
    return artifacts;
  };
  const operation = async (
    artifact: SharedArtifact,
    action: CollectiveArtifactAction,
    payload: Record<string, unknown>,
    requestId: string,
    ownerRevision?: number,
  ) => {
    const result = await post<{ value: unknown }>('owner/request', {
      ...coordinates,
      artifactId: artifact.artifactId,
      sourceEventId: artifact.sourceEventId,
      action,
      payload,
      requestId,
      ...(ownerRevision ? { ownerRevision } : {}),
    });
    return result.value;
  };
  const read = async (artifact: SharedArtifact, ownerRevision?: number) => {
    const requestId = crypto.randomUUID();
    const value = await readArtifactJsonPages((page) => operation(artifact, 'read', page, requestId, ownerRevision));
    const parsed = sharedMarkdownViewSchema.parse(value);
    assertSharedAnnotationPage(parsed, 0);
    if (parsed.contentRef !== artifact.contentRef || (ownerRevision && parsed.ownerRevision !== ownerRevision))
      throw new Error('作品版本已改变，请重新打开。');
    if (ownerRevision === undefined && parsed.ownerRevision !== artifact.versions.at(-1)?.ownerRevision)
      throw new SharedArtifactCatalogueReconciled();
    const expected =
      artifact.versions.find((version) => version.ownerRevision === parsed.ownerRevision) ??
      (await historyClient.version(artifact, parsed.ownerRevision));
    const bytes = new TextEncoder().encode(parsed.text);
    const actual = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const actualDigest = `sha256:${Array.from(actual, (item) => item.toString(16).padStart(2, '0')).join('')}`;
    if (!expected || expected.blobDigest !== parsed.blobDigest || actualDigest !== parsed.blobDigest)
      throw new Error('作品版本已改变，请重新打开。');
    return parsed;
  };
  const publish = async (input: {
    file: File;
    title: string;
    connectionId: string;
    sourceEventId: string;
    workId?: string;
  }) => {
    if (input.file.size > 65536) throw new Error('目前支持 64KB 以内的 Markdown。');
    const bytes = new Uint8Array(await input.file.arrayBuffer());
    if (bytes.length > 65536) throw new Error('目前支持 64KB 以内的 Markdown。');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('请选择 UTF-8 编码的 Markdown。');
    }
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const blobDigest = `sha256:${Array.from(hash, (item) => item.toString(16).padStart(2, '0')).join('')}`;
    const storageKey = `collective-publication:${namespace}:${JSON.stringify([input.sourceEventId, input.connectionId, blobDigest, input.title, input.workId ?? null])}`;
    const previous = window.localStorage.getItem(storageKey);
    const requestId = previous ?? crypto.randomUUID();
    // Retain the same operation before the first network effect. No selected file bytes or credentials enter storage.
    window.localStorage.setItem(storageKey, requestId);
    const prepared = await post<{ publication: { publicationId: string; status: string; artifact?: unknown } }>(
      'publications/prepare',
      {
        ...coordinates,
        connectionId: input.connectionId,
        sourceEventId: input.sourceEventId,
        requestId,
        title: input.title,
        blobDigest,
        ...(input.workId ? { workId: input.workId } : {}),
      },
    );
    let artifact = prepared.publication.artifact;
    if (prepared.publication.status !== 'published') {
      const bytesBase64 = btoa(Array.from(bytes, (item) => String.fromCharCode(item)).join(''));
      const result = await post<{ publication: { artifact: unknown } }>('publications/send', {
        publicationId: prepared.publication.publicationId,
        bytesBase64,
      });
      artifact = result.publication.artifact;
    }
    // The receipt remains recoverable after completion; selecting the same publication cannot create another work.
    return collectiveArtifactProjectionSchema.parse(artifact);
  };
  const promoteWorkResult = async (fileId: string) => {
    const result = await post<{ publication: { status: string; artifact?: unknown } }>('publications/promote-result', {
      ...coordinates,
      fileId,
    });
    if (result.publication.status !== 'published' || !result.publication.artifact)
      throw new Error('结果作品仍在同步，请稍后重试。');
    return collectiveArtifactProjectionSchema.parse(result.publication.artifact);
  };
  const openWorkResult = async (fileId: string) => {
    const result = await post<{ resolution: unknown }>('publications/resolve-result', { ...coordinates, fileId });
    const resolution = workResultArtifactResolutionSchema.parse(result.resolution);
    if (resolution.status === 'published') return resolution.artifact;
    if (!resolution.mayPromote)
      throw new Error(
        resolution.status === 'pending' ? '结果作品仍在同步，请稍后重试。' : '结果作品尚未发布，请稍后重试。',
      );
    return promoteWorkResult(fileId);
  };
  const sendFeedback = (input: Parameters<typeof sendSharedArtifactFeedback>[3]) =>
    sendSharedArtifactFeedback(request, namespace, operation, input);
  const resolveModification = (
    artifact: SharedArtifact,
    record: CollectiveModificationProjection,
    action: 'cancel' | 'reject',
  ) => resolveSharedArtifactModification(operation, namespace, artifact, record, action);
  const previewModification = (
    artifact: SharedArtifact,
    selection: { requestId: string; proposalRef: string },
  ): Promise<SharedArtifactModificationPreview> =>
    previewSharedArtifactModification(operation, artifact, selection, (revision) =>
      historyClient.version(artifact, revision),
    );
  const adoptModification = (
    artifact: SharedArtifact,
    preview: SharedArtifactModificationPreview,
  ): ReturnType<typeof adoptSharedArtifactModification> =>
    adoptSharedArtifactModification(operation, namespace, artifact, preview);
  const moreRequests = async (artifact: SharedArtifact, view: SharedMarkdownView) => {
    const expanded = structuredClone(view);
    const requestId = crypto.randomUUID();
    await appendSharedRequestPage(expanded, (page) =>
      readArtifactJsonPages((cursor) =>
        operation(artifact, 'read', { ...cursor, ...page }, requestId, view.ownerRevision),
      ),
    );
    return expanded;
  };
  const moreReplies = async (
    artifact: SharedArtifact,
    view: SharedMarkdownView,
    annotationId: string,
    offset: number,
  ) => {
    const requestId = crypto.randomUUID();
    const page = sharedMarkdownViewSchema.parse(
      await readArtifactJsonPages((cursor) =>
        operation(artifact, 'read', { ...cursor, annotationId, replyOffset: offset }, requestId, view.ownerRevision),
      ),
    );
    return verifySharedAnnotationReplyPage(view, annotationId, offset, page);
  };
  return {
    projectReferences: projectArtifactClient(request, coordinates, namespace),
    moreAnnotations: async (artifact: SharedArtifact, view: SharedMarkdownView) => {
      const annotationOffset = view.view.annotationPage.nextOffset;
      if (annotationOffset === undefined) return view;
      const requestId = crypto.randomUUID();
      const page = sharedMarkdownViewSchema.parse(
        await readArtifactJsonPages((cursor) =>
          operation(artifact, 'read', { ...cursor, annotationOffset }, requestId, view.ownerRevision),
        ),
      );
      return appendSharedAnnotationPage(view, page);
    },
    moreReplies,
    sendReply: (input: Parameters<typeof sendSharedAnnotationReply>[3]) =>
      sendSharedAnnotationReply(request, operation, namespace, input),
    setAnnotationState: (input: Parameters<typeof setSharedAnnotationState>[2]) =>
      setSharedAnnotationState(operation, namespace, input),
    management: sharedArtifactManagementClient(request, coordinates, namespace),
    ...historyClient,
    list,
    read,
    moreRequests,
    publish,
    openWorkResult,
    operation,
    request,
    sendFeedback,
    resolveModification,
    previewModification,
    adoptModification,
  };
}

async function appendSharedRequestPage(
  view: SharedMarkdownView,
  read: (page: Record<string, unknown>) => Promise<unknown>,
) {
  const requests = view.modifications;
  if (!requests) return;
  const seen = new Set(requests.requests.map((request) => request.requestId));
  const offset = requests.nextOffset;
  if (offset !== undefined) {
    const page = sharedMarkdownViewSchema.parse(await read({ requestOffset: offset }));
    const next = page.modifications;
    if (
      !requests.snapshot ||
      !next ||
      next.snapshot !== requests.snapshot ||
      next.total !== requests.total ||
      next.offset !== offset ||
      page.contentRef !== view.contentRef ||
      page.ownerRevision !== view.ownerRevision ||
      page.blobDigest !== view.blobDigest ||
      page.view.review.revision !== view.view.review.revision ||
      next.requests.length === 0 ||
      (next.nextOffset !== undefined && next.nextOffset <= offset)
    )
      throw new Error('修改记录正在更新，请重新读取。');
    for (const request of next.requests) {
      if (seen.has(request.requestId)) throw new Error('修改记录正在更新，请重新读取。');
      seen.add(request.requestId);
      requests.requests.push(request);
    }
    requests.nextOffset = next.nextOffset;
  }
  if (requests.nextOffset === undefined && requests.requests.length !== requests.total)
    throw new Error('修改记录尚未读完，请重新读取。');
}
