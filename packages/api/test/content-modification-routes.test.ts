import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { EventAuditLog } from '../src/domains/cats/services/orchestration/EventAuditLog.js';
import { createContentModificationIntegration } from '../src/domains/collaborative-content/modification/composition.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { createWorkspaceContentSource } from '../src/domains/workspace/workspace-content-source-factory.js';
import { signEditToken } from '../src/domains/workspace/workspace-edit.js';
import { registerCallbackContentModificationRoutes } from '../src/routes/callback-content-modification-routes.js';
import { registerContentModificationRoutes } from '../src/routes/content-modification-routes.js';
import { workspaceRoutes } from '../src/routes/workspace.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

test('production modification composition admits a direct human, the scoped named cat returns a patch, only a fresh human accept can write', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-modification-routes-')),
    path = join(root, 'guide.md');
  const base = '# Guide\n' + 'A quoted source.\n'.repeat(800);
  await writeFile(path, base);
  const priorRoots = process.env.WORKSPACE_LINKED_ROOTS;
  process.env.WORKSPACE_LINKED_ROOTS = `f309_actual_file:${root}`;
  t.after(() => {
    if (priorRoots === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = priorRoots;
  });
  const source = createWorkspaceContentSource('operator');
  const f = await createLiveReviewFixture(root, 'image/png', undefined, source);
  const fileStore = new WorkspaceContentReviewStore(join(root, 'files.sqlite'));
  const files = new WorkspaceContentReviewService({ source, store: fileStore });
  const failures: unknown[] = [];
  const deps = createContentModificationIntegration({
    dataDir: root,
    source,
    files,
    artifacts: f,
    tasks: f.tasks,
    messages: f.messages,
    changed: () => {},
    onError: (e) => failures.push(e),
  });
  const app = Fastify(),
    registry = new InvocationRegistry();
  const actor = await registry.create('operator', 'codex-astra', f.thread.id);
  const stranger = await registry.create('operator', 'opus5', f.thread.id);
  const foreign = await registry.create('operator', 'codex-astra', 'another-thread');
  registerContentModificationRoutes(app, deps);
  await app.register(workspaceRoutes, { auditLog: new EventAuditLog({ auditDir: join(root, 'audit') }) });
  await registerCallbackContentModificationRoutes(app, {
    text: deps.text,
    sourceDiscussions: deps.sourceDiscussions,
    threads: f.threads,
    registry,
    changed: () => {},
  });
  t.after(async () => {
    await app.close();
    await f.dispatch.close();
    deps.writer.close();
    fileStore.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const headers = { 'x-cat-cafe-user': 'operator' },
    cat = { 'x-invocation-id': actor.invocationId, 'x-callback-token': actor.callbackToken };
  const location = await app.inject({
    method: 'POST',
    url: '/api/workspace/resolve-file-source',
    headers,
    payload: { root, path: 'guide.md' },
  });
  assert.equal(location.statusCode, 200, location.body);
  const locator = { worktreeId: location.json().worktreeId as string, path: location.json().path as string };
  assert.match(locator.worktreeId, /^f063_root_v1_[a-f0-9]{64}$/);
  const treeLocation = await app.inject({
    method: 'POST',
    url: '/api/workspace/resolve-file-source',
    headers,
    payload: { worktreeId: 'linked_f309_actual_file', path: 'guide.md' },
  });
  assert.equal(treeLocation.statusCode, 200, treeLocation.body);
  assert.equal(treeLocation.json().worktreeId, locator.worktreeId);
  const opened = await files.prepare({
    principal: f.human,
    locator,
    operationId: 'open',
  });
  const fromTree = await files.prepare({
    principal: f.human,
    locator: { worktreeId: treeLocation.json().worktreeId, path: treeLocation.json().path },
    operationId: 'same-file-from-tree',
  });
  assert.equal(
    fromTree.review.reviewId,
    opened.review.reviewId,
    'file tree and selected artifact share the original canonical ledger',
  );
  const annotated = await files.annotate({
    principal: f.human,
    reviewId: opened.review.reviewId,
    expectedRevision: opened.review.revision,
    operationId: 'original-opinion',
    body: '请保留原文例子。',
    target: { kind: 'text_quote', quote: 'Guide' },
  });
  const payload = {
    operationId: randomUUID(),
    targetCatId: 'codex-astra',
    threadId: f.thread.id,
    intent: { body: '把标题 Guide 改成 Instructions。' },
    source: {
      kind: 'workspace',
      locator,
      expectedSourceRevision: opened.review.source.revision,
      reviewId: opened.review.reviewId,
      expectedReviewRevision: annotated.review.revision,
    },
  };
  for (const denied of [
    {},
    cat,
    { ...headers, 'x-agent-key-secret': 'pretend' },
    { ...headers, origin: 'http://foreign.example' },
  ]) {
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/content-modifications', headers: denied, payload })).statusCode,
      401,
    );
  }
  const unknownTarget = await app.inject({
    method: 'POST',
    url: '/api/content-modifications',
    headers,
    payload: { ...payload, targetCatId: 'not-a-cat' },
  });
  assert.equal(unknownTarget.statusCode, 409);
  assert.equal(unknownTarget.json().error, 'target_unavailable');
  const selection = (quote: string, auth = headers) =>
    app.inject({
      method: 'POST',
      url: '/api/content-modifications/selection',
      headers: auth,
      payload: { source: payload.source, quote },
    });
  const selected = await selection('Guide');
  assert.equal(selected.statusCode, 200, selected.body);
  assert.equal(selected.json().selection.quote, 'Guide');
  assert.equal(selected.json().selection.start, 2);
  // Parent Alpha 2026-09-25: a selection made on the rendered page (heading → paragraph arrives as a blank
  // line) was refused against raw Markdown. The owner now maps it to the raw range behind it.
  const rendered = await selection('Guide\n\nA quoted');
  assert.equal(rendered.statusCode, 200, rendered.body);
  assert.equal(rendered.json().selection.start, 2);
  assert.equal(rendered.json().selection.quote, 'Guide\nA quoted');
  assert.equal(
    (await selection('A quoted source.')).statusCode,
    409,
    'ambiguous rendered quotes cannot invent raw offsets',
  );
  assert.equal((await selection('Guide', {} as typeof headers)).statusCode, 401);
  assert.equal(f.tasks.listByThread(f.thread.id).length, 1, 'resolving a selection never admits a Task');
  const submitted = await app.inject({ method: 'POST', url: '/api/content-modifications', headers, payload });
  assert.equal(submitted.statusCode, 200, submitted.body);
  const request = submitted.json();
  assert.equal(request.stage, 'queued');
  assert.deepEqual(failures, []);
  const catalogue = await app.inject({
    method: 'POST',
    url: '/api/content-modifications/context',
    headers,
    payload: { source: payload.source },
  });
  assert.equal(catalogue.statusCode, 200, catalogue.body);
  assert.equal(catalogue.json().requests[0].record.requestId, request.record.requestId);
  assert.equal(catalogue.json().contexts[0].taskContext.kind, 'text');
  assert.equal(catalogue.json().contexts[0].targetCatId, 'codex-astra');
  assert.equal(catalogue.json().suggestedCatId, undefined, 'ordinary files cannot guess their author');
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/content-modifications/context',
        headers: cat,
        payload: { source: payload.source },
      })
    ).statusCode,
    401,
  );
  const requestId = request.record.requestId,
    url = `/api/content-modifications/${requestId}`;
  assert.equal((await app.inject({ url, headers: { 'x-cat-cafe-user': 'other' } })).statusCode, 404);
  const read = (body: unknown, auth = cat) =>
    app.inject({ method: 'POST', url: '/api/callbacks/content-modification/read', headers: auth, payload: body });
  for (const wrong of [stranger, foreign])
    assert.equal(
      (await read({ requestId }, { 'x-invocation-id': wrong.invocationId, 'x-callback-token': wrong.callbackToken }))
        .statusCode >= 400,
      true,
    );
  let chunks = '',
    cursor = 0,
    snapshot: string | undefined;
  do {
    const page = await read({ requestId, view: 'source', cursor, ...(snapshot ? { expectedSnapshot: snapshot } : {}) });
    assert.equal(page.statusCode, 200, page.body);
    assert.ok(page.body.length <= 12000);
    const data = page.json();
    chunks += data.json;
    cursor = data.nextCursor;
    snapshot = data.snapshot;
  } while (cursor !== null);
  assert.equal(JSON.parse(chunks).text, base);
  assert.equal(JSON.parse(chunks).sourceDiscussions?.[0]?.review.annotations[0]?.body, '请保留原文例子。');
  const overview = await read({ requestId });
  const inspected = JSON.parse(overview.json().json);
  const response = {
    requestId,
    operationId: randomUUID(),
    expectedTaskRevision: inspected.taskRevision,
    expectedProposalRevision: 0,
    baseRevision: opened.review.source.revision,
    edits: [{ start: 2, end: 7, expectedText: 'Guide', replacement: 'Instructions' }],
    response: '标题已更新，其余内容不变。',
  };
  const returned = await app.inject({
    method: 'POST',
    url: '/api/callbacks/content-modification/respond',
    headers: cat,
    payload: response,
  });
  assert.equal(returned.statusCode, 200, returned.body);
  assert.equal(returned.json().state, 'awaiting_human_acceptance');
  assert.equal(await readFile(path, 'utf8'), base);
  const result = await app.inject({ url, headers });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().candidates[0].proposal.authorCatId, 'codex-astra');
  const acceptance = {
    requestId,
    candidateRef: returned.json().proposalRef,
    acceptOperationId: randomUUID(),
    locator: payload.source.locator,
    baseRevision: payload.source.expectedSourceRevision,
    editSessionToken: signEditToken(locator.worktreeId),
  };
  const accept = (body: unknown, auth: Record<string, string> = headers) =>
    app.inject({ method: 'POST', url: `${url}/accept`, headers: auth, payload: body });
  assert.equal((await accept(acceptance, cat)).statusCode, 401);
  assert.equal((await accept({ ...acceptance, editSessionToken: signEditToken('wrong-worktree') })).statusCode, 401);
  assert.equal((await accept({ ...acceptance, candidateRef: 'unrelated-result' })).statusCode, 404);
  assert.equal((await accept({ ...acceptance, bytes: 'browser-chosen-bytes' })).statusCode, 400);
  assert.equal(await readFile(path, 'utf8'), base);
  const accepted = await accept(acceptance);
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().receipt.state, 'applied');
  assert.equal('proof' in accepted.json().receipt, false);
  assert.equal(await readFile(path, 'utf8'), base.replace('Guide', 'Instructions'));
  const reopened = (await app.inject({ url, headers })).json();
  assert.equal(reopened.acceptances[0].receipt.state, 'applied');
});
