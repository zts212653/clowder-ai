import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { respondWithMediaVersionSchema } from '@cat-cafe/shared';
import { mediaPublicationFixture } from './media-publication-fixture.js';

export function publicationResponseRecord(
  fixture: Pick<Awaited<ReturnType<typeof mediaPublicationFixture>>, 'messages' | 'dispatch'>,
  invocationId: string,
) {
  const start = fixture.dispatch.starts.find((item) => item.invocationId === invocationId);
  assert.ok(start);
  const message = fixture.messages.getByIdempotencyKey(
    start.userId,
    start.threadId,
    `message-lifecycle-response:${invocationId}`,
  );
  assert.ok(message?.lifecycle?.kind === 'response');
  assert.equal(message.lifecycle.invocationId, invocationId);
  return { message, response: message.lifecycle };
}

/** Observe the real Queue finalizer before taking an immutable-history baseline. */
export async function waitForRecoveryCarrierTerminal(
  fixture: Pick<Awaited<ReturnType<typeof mediaPublicationFixture>>, 'messages' | 'dispatch'>,
  messageId: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const start = fixture.dispatch.starts.find((item) => item.messageIds.includes(messageId));
    const response =
      start &&
      fixture.messages.getByIdempotencyKey(
        start.userId,
        start.threadId,
        `message-lifecycle-response:${start.invocationId}`,
      );
    if (start && response?.lifecycle?.kind === 'response' && response.lifecycle.status === 'completed') {
      assert.equal(response.lifecycle.invocationId, start.invocationId);
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('The released recovery provider did not finish its persisted carrier');
}

export async function publicationRecoveryFixture(t: Parameters<typeof mediaPublicationFixture>[0], terminal = true) {
  const f = await mediaPublicationFixture(t, false, { publicationLedger: true });
  f.publish('append');
  await f.recover();
  const intent = f.store.returns.publicationForRequest(f.request.record.requestId);
  assert.ok(intent?.messageId);
  const childId = await f.dispatch.waitForAwakening(intent.messageId);
  const review = f.store.get(intent.reviewId)!;
  const round = review.rounds.at(-1)!;
  const response = respondWithMediaVersionSchema.parse({
    requestId: intent.requestId,
    reviewId: intent.reviewId,
    expectedRevision: review.revision,
    expectedTaskRevision: intent.expectedTaskRevision,
    expectedOwnerRevision: intent.ownerRevision,
    expectedLedgerRevision: round.ledgerRevision,
    artifactRef: intent.source.artifactRef,
    expectedArtifactRevision: intent.source.artifactRevision,
    operationId: randomUUID(),
    responses: round.annotations.map((annotation) => ({
      annotationId: annotation.id,
      disposition: 'addressed',
      explanation: '明确续办原图，不重新生成。',
    })),
  });
  async function end(id: string) {
    f.dispatch.turns.transitionTerminal(id, {
      status: 'succeeded',
      terminalReason: 'fixture_no_reservation',
      endedAt: Date.now(),
    });
    await f.dispatch.releaseProvider(id);
    const start = f.dispatch.starts.find((item) => item.invocationId === id);
    const carrier = f.carriers().find((item) => start?.messageIds.includes(item.id));
    assert.ok(carrier);
    await waitForRecoveryCarrierTerminal(f, carrier.id);
  }
  if (terminal) await end(childId);
  const command = {
    operationId: randomUUID(),
    expectedRequestRevision: f.store.requests.get(intent.requestId, 'operator')!.revision,
    expectedGeneration: 0,
    recoveryOfReceiptRef: intent.receiptRef,
    expectedPriorInvocationId: childId,
    response,
  };
  const ownerInput = {
    method: 'POST' as const,
    url: `/api/content-modifications/${intent.requestId}/publication-recovery`,
    headers: { 'x-cat-cafe-user': 'operator' },
    payload: command,
  };
  async function admittedChild() {
    const accepted = await f.app.inject(ownerInput);
    assert.equal(accepted.statusCode, 200, accepted.body);
    const current = f.store.returns.publicationForRequest(intent.requestId)!;
    assert.ok(current.messageId);
    const id = await f.dispatch.waitForAwakening(current.messageId);
    const credentials = f.dispatch.credentials.get(id)!;
    return {
      current,
      id,
      callback: {
        method: 'POST' as const,
        url: '/api/callbacks/artifact-review/respond',
        headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
        payload: response,
      },
    };
  }
  return { ...f, intent, childId, response, command, ownerInput, end, admittedChild };
}
