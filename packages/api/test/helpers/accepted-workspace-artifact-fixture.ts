import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { GlobalArtifactWorkLineageResolverHolder } from '../../src/domains/video-studio/content-owner/global-artifact-work-lineage.js';
import { signEditToken } from '../../src/domains/workspace/workspace-edit.ts';
import { registerContentModificationRoutes } from '../../src/routes/content-modification-routes.ts';
import { threadsRoutes } from '../../src/routes/threads.ts';
import { firstFileFixture } from './content-modification-first-file-fixture.ts';

export async function acceptedFileFixture(t: import('node:test').TestContext, explicitRequest = false) {
  const f = await firstFileFixture(t);
  registerContentModificationRoutes(f.app, f.integration);
  const view = explicitRequest
    ? await f.files.prepare({ principal: f.human, locator: f.locator, operationId: 'open-original' })
    : null;
  const result = explicitRequest
    ? await f.app.inject({
        method: 'POST',
        url: '/api/content-modifications',
        headers: { 'x-cat-cafe-user': 'operator' },
        payload: {
          operationId: randomUUID(),
          threadId: f.thread.id,
          targetCatId: 'codex-astra',
          intent: { body: 'Revise the first word and preserve the rest.' },
          source: {
            kind: 'workspace',
            locator: view.review.source.locator,
            expectedSourceRevision: view.review.source.revision,
            reviewId: view.review.reviewId,
            expectedReviewRevision: view.review.revision,
          },
        },
      })
    : await f.takeover();
  assert.equal(result.statusCode, 200, result.body);
  const request = result.json().record;
  const source = await f.integration.text.read(request.requestId, f.cat);
  const start = source.source.text.indexOf('First');
  assert.ok(start >= 0);
  const returned = await f.integration.text.respond(
    {
      requestId: request.requestId,
      operationId: randomUUID(),
      expectedTaskRevision: source.taskRevision,
      expectedProposalRevision: 0,
      baseRevision: source.source.source.revision,
      edits: [{ start, end: start + 5, expectedText: 'First', replacement: 'Revised' }],
      response: 'Only the first word changed; the candidate awaits explicit acceptance.',
    },
    f.cat,
  );
  await f.integration.receipts.projectCandidate(request, returned.proposal);
  const artifacts = Fastify();
  const holder = { current: f.integration.workspaceArtifacts };
  const lineageHolder: GlobalArtifactWorkLineageResolverHolder = { current: undefined };
  await artifacts.register(threadsRoutes, {
    threadStore: f.threads,
    messageStore: f.messages,
    taskStore: f.tasks,
    acceptedWorkspaceArtifacts: holder,
    artifactWorkLineage: lineageHolder,
  });
  t.after(() => artifacts.close());
  const get = (user = 'operator', url = `/api/threads/${f.thread.id}/artifacts`) =>
    artifacts.inject({ method: 'GET', url, headers: { 'x-cat-cafe-user': user } });
  const accept = () =>
    f.app.inject({
      method: 'POST',
      url: `/api/content-modifications/${request.requestId}/accept`,
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: {
        requestId: request.requestId,
        candidateRef: returned.proposal.proposalRef,
        acceptOperationId: randomUUID(),
        locator: f.locator,
        baseRevision: source.source.source.revision,
        editSessionToken: signEditToken(f.locator.worktreeId),
      },
    });
  return { ...f, artifacts, holder, lineageHolder, request, sourceRead: source, returned, get, accept };
}
