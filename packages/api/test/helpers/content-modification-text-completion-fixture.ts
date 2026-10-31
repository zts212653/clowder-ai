import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { signEditToken } from '../../src/domains/workspace/workspace-edit.js';
import { cancellationFixture } from './content-modification-cancellation-fixture.js';

export async function prepareTextCompletion(
  t: TestContext,
  options: {
    continuation?: boolean;
    continuationFile?: string;
    deferDelivery?: boolean;
    authenticateDelivery?: boolean;
  } = {},
) {
  const f = await cancellationFixture(t, { authenticateDelivery: options.authenticateDelivery });
  const rootRequest = await f.integration.requests.submit(f.payload, f.human);
  let payload = f.payload;
  if (options.continuationFile) {
    await writeFile(join(f.root, options.continuationFile), 'The old text.');
    const locator = { ...f.payload.source.locator, path: options.continuationFile };
    const opened = await f.files.prepare({ principal: f.human, locator, operationId: randomUUID() });
    payload = {
      ...f.payload,
      source: {
        ...f.payload.source,
        locator,
        reviewId: opened.review.reviewId,
        expectedReviewRevision: opened.review.revision,
        expectedSourceRevision: opened.review.source.revision,
      },
    };
  }
  const request = options.continuation
    ? await f.integration.requests.submit(
        {
          ...payload,
          operationId: randomUUID(),
          taskContext: {
            kind: 'text',
            taskId: rootRequest.record.progress.task!.taskId,
            expectedTaskRevision: rootRequest.record.progress.task!.revision,
          },
        },
        f.human,
      )
    : rootRequest;
  const requestId = request.record.requestId;
  const source = await f.integration.text.read(requestId, f.cat);
  const returned = await f.integration.text.respond(
    {
      requestId,
      operationId: randomUUID(),
      expectedTaskRevision: request.record.progress.task!.revision,
      expectedProposalRevision: 0,
      baseRevision: source.source.source.revision,
      edits: [{ start: 4, end: 7, expectedText: 'old', replacement: 'new' }],
      response: 'Use new.',
    },
    f.cat,
  );
  // A continuation can be queued behind its root request. Settle both exact
  // initial deliveries before measuring any wake caused by accepting the file.
  for (const initialRequestId of new Set([rootRequest.record.requestId, request.record.requestId])) {
    const deliveries = f.messages
      .getByThreadIncludingQueued(f.thread.id)
      .filter(
        (message) =>
          message.source?.meta?.kind === 'request_text_edit' && message.source.meta.requestId === initialRequestId,
      );
    assert.equal(deliveries.length, 1, 'each initial request has exactly one Host delivery');
    const invocationId = await f.dispatch.waitForAwakening(deliveries[0]!.id);
    await f.dispatch.releaseProvider(invocationId);
  }
  await f.dispatch.close();
  const startsBeforeAcceptance = f.starts.length;
  const drain = f.dispatcher.drain.bind(f.dispatcher);
  if (options.deferDelivery) f.dispatcher.drain = async () => {};
  const command = {
    requestId,
    candidateRef: returned.proposal.proposalRef,
    acceptOperationId: randomUUID(),
    baseRevision: source.source.source.revision,
    locator: payload.source.locator,
    editSessionToken: signEditToken('work'),
  };
  const accept = async () => {
    const accepted = await f.integration.results.accept(command, f.human);
    assert.equal(accepted.receipt.state, 'applied');
    assert.equal(await readFile(join(f.root, payload.source.locator.path), 'utf8'), 'The new text.');
    return accepted;
  };
  return {
    ...f,
    payload,
    rootRequest,
    request,
    requestId,
    command,
    accept,
    startsBeforeAcceptance,
    resumeDelivery: async () => {
      f.dispatcher.drain = drain;
      await drain();
    },
  };
}

export async function appliedText(t: TestContext, options: Parameters<typeof prepareTextCompletion>[1] = {}) {
  const f = await prepareTextCompletion(t, options);
  return { ...f, accepted: await f.accept() };
}

export function completionMessages(f: Awaited<ReturnType<typeof prepareTextCompletion>>) {
  return f.messages
    .getByThreadIncludingQueued(f.thread.id)
    .filter((message) => message.source?.meta?.kind === 'text_writeback_completion');
}
