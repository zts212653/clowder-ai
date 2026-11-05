import { publishCollectiveArtifactRequestSchema } from '@cat-cafe/shared';
import type { ClientRequest } from './client-request.js';
import type { CollectiveEventEnvelope, CollectiveRecipient } from './client-types.js';
import type { SharedArtifact, SharedMarkdownView } from './collective-artifact-client.js';
import type { SharedArtifactDraftSelection } from './shared-artifact-draft.js';

export async function sendSharedArtifactFeedback(
  request: ClientRequest,
  namespace: string,
  operation: (
    artifact: SharedArtifact,
    action: 'annotate' | 'propose',
    payload: Record<string, unknown>,
    requestId: string,
    ownerRevision?: number,
  ) => Promise<unknown>,
  input: {
    artifact: SharedArtifact;
    view: SharedMarkdownView;
    selections: readonly SharedArtifactDraftSelection[];
    body: string;
    recipient: CollectiveRecipient;
    rework?: { requestId: string; proposalRef: string };
  },
) {
  const { artifact, view, selections, body, recipient, rework } = input;
  if (
    (!selections.length && !rework) ||
    (rework && (selections.length > 0 || recipient.kind !== 'agent')) ||
    selections.some(
      (selection) =>
        selection.artifactId !== artifact.artifactId ||
        selection.ownerRevision !== view.ownerRevision ||
        selection.blobDigest !== view.blobDigest,
    )
  )
    throw new Error('引用的版本已改变，请重新选取；草稿已保留。');
  const intent = {
    serviceInstanceId: artifact.serviceInstanceId,
    collectiveId: artifact.collectiveId,
    artifactId: artifact.artifactId,
    sourceEventId: artifact.sourceEventId,
    ownerRevision: view.ownerRevision,
    annotationIds: [],
    ...(rework ? { rework } : { selections: selections.map((selection) => selection.span) }),
    body,
    recipient,
  };
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(intent))));
  const key = `collective-feedback:${namespace}:${Array.from(hash, (item) => item.toString(16).padStart(2, '0')).join('')}`;
  const saved = localStorage.getItem(key);
  const pending = publishCollectiveArtifactRequestSchema.parse(
    saved
      ? JSON.parse(saved)
      : {
          ...intent,
          expectedReviewRevision: view.view.review.revision,
          clientEventId: crypto.randomUUID(),
        },
  );
  localStorage.setItem(key, JSON.stringify(pending));
  if (recipient.kind === 'agent') {
    const sent = await request<{ source: CollectiveEventEnvelope }>('/api/artifacts/requests/publish', {
      method: 'POST',
      body: JSON.stringify(pending),
    });
    await operation(
      artifact,
      'propose',
      {
        kind: 'request-modification',
        messageEventId: sent.source.eventId,
        annotationIds: [],
        selections: pending.selections,
        ...(pending.rework ? { rework: pending.rework } : {}),
        expectedReviewRevision: pending.expectedReviewRevision,
      },
      `prepare:${pending.clientEventId}`,
      pending.ownerRevision,
    );
  } else {
    const sent = await request<CollectiveEventEnvelope>('/api/events/human', {
      method: 'POST',
      body: JSON.stringify({
        serviceInstanceId: artifact.serviceInstanceId,
        collectiveId: artifact.collectiveId,
        clientEventId: pending.clientEventId,
        body: pending.body,
        recipient: pending.recipient,
        replyToEventId: artifact.sourceEventId,
        location: {
          channelId: artifact.sourceLocation.channelId,
          rootEventId: artifact.sourceLocation.rootEventId ?? artifact.sourceEventId,
        },
      }),
    });
    for (const [index, selection] of selections.entries()) {
      await operation(
        artifact,
        'annotate',
        {
          kind: 'annotate',
          messageEventId: sent.eventId,
          quote: view.text.slice(selection.span.start, selection.span.end),
          selection: selection.span,
          expectedReviewRevision: pending.expectedReviewRevision,
        },
        `annotation:${pending.clientEventId}:${index}`,
        pending.ownerRevision,
      );
    }
  }
  localStorage.removeItem(key);
}
