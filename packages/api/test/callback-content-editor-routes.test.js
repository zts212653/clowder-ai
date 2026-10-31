import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { NamedCatContentService } from '../dist/domains/collaborative-content/named-cat-content-service.js';
import { WorkspaceEditorService } from '../dist/domains/collaborative-content/workspace-editor-service.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackContentEditorRoutes } from '../dist/routes/callback-content-editor-routes.js';

test('independent document callbacks use registered identity and reject forged bodies or unavailable thread authority', async (t) => {
  const registry = new InvocationRegistry();
  const credentials = await registry.create('owner-1', 'codex-astra', 'thread-1');
  const headers = { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken };
  const calls = [];
  let thread = { id: 'thread-1', createdBy: 'owner-1', deletedAt: null };
  let failRead = false;
  const holder = {
    current: {
      inspect: async (input) => {
        calls.push(input);
        return { status: 'ready' };
      },
      edit: async (input) => {
        calls.push(input);
        return { status: 'applied' };
      },
    },
  };
  const app = Fastify();
  t.after(() => app.close());
  registerCallbackAuthHook(app, registry);
  registerCallbackContentEditorRoutes(app, {
    holder,
    threadStore: {
      get: async (id) => {
        if (failRead) throw new Error('unavailable');
        return id === 'thread-1' ? thread : null;
      },
      list: async () => [thread],
    },
  });
  const call = (payload, auth = headers, operation = 'inspect') =>
    app.inject({ method: 'POST', url: `/api/callbacks/content-editor/${operation}`, headers: auth, payload });
  assert.equal((await call({ contentRef: 'doc:1' }, {})).statusCode, 401);
  assert.equal((await call({ contentRef: 'doc:1' }, { ...headers, 'x-callback-token': 'wrong' })).statusCode, 401);
  for (const extra of [
    { actor: { kind: 'human', actorId: 'owner-1' } },
    { principal: { catId: 'codex-sol' } },
    { sessionToken: 'human-bearer' },
  ])
    assert.equal((await call({ contentRef: 'doc:1', ...extra })).statusCode, 400);
  assert.equal((await call({ contentRef: 'doc:1', threadId: 'other-owner' })).statusCode, 403);
  assert.equal((await call({ contentRef: 'doc:1' })).statusCode, 200);
  assert.equal(calls[0].principal.catId, 'codex-astra');
  assert.equal(calls[0].principal.userId, 'owner-1');
  const edit = {
    contentRef: 'doc:1',
    expectedOwnerRevision: 1,
    operationId: 'once',
    operation: { kind: 'comment', target: { paragraphId: 'p:1:anchor', textQuote: 'exact text' }, body: 'Review' },
  };
  assert.equal((await call(edit, headers, 'edit')).statusCode, 200);
  assert.equal(calls[1].principal.invocationId, credentials.invocationId);
  assert.equal(
    (await call({ ...edit, operation: { kind: 'direct-settlement', bytes: [1] } }, headers, 'edit')).statusCode,
    400,
  );
  assert.equal(
    (await call({ ...edit, operation: { ...edit.operation, attribution: { author: 'forged' } } }, headers, 'edit'))
      .statusCode,
    400,
  );
  assert.equal((await call({ workspace: { worktreeId: 'wt-1', path: 'sample.docx' } })).statusCode, 200);
  assert.deepEqual(calls[2].workspace, { worktreeId: 'wt-1', path: 'sample.docx' });
  assert.equal(
    (await call({ contentRef: 'doc:1', workspace: { worktreeId: 'wt-1', path: 'other.docx' } })).statusCode,
    400,
  );
  assert.equal((await call({})).statusCode, 400);
  thread = { ...thread, deletedAt: Date.now() };
  assert.equal((await call(edit, headers, 'edit')).statusCode, 410);
  failRead = true;
  assert.equal((await call(edit, headers, 'edit')).statusCode, 503);
  assert.equal(calls.length, 3, 'all denied requests stop before the document service');
});

test('named-cat service rejects another owner before issuing any editor session', async () => {
  const service = new NamedCatContentService({
    ownerUserId: 'owner-1',
    sessions: { issue: async () => assert.fail('foreign owner session') },
    workspace: { resolveExisting: async () => assert.fail('foreign owner lookup') },
  });
  await assert.rejects(
    service.inspect({
      principal: { userId: 'foreign-owner', catId: 'codex-astra' },
      contentRef: 'doc:1',
      cursor: 0,
      limit: 4,
      maxChars: 1000,
    }),
    (error) => error.code === 'PRINCIPAL_MISMATCH',
  );
  await assert.rejects(
    service.inspect({
      principal: { userId: 'foreign-owner', catId: 'codex-astra' },
      workspace: { worktreeId: 'wt', path: 'private.docx' },
    }),
    (error) => error.code === 'PRINCIPAL_MISMATCH',
  );
});

test('Workspace discovery reads an existing owner reference and cannot import, bind or enable a file', async () => {
  const loaded = [];
  const missing = new Error('document absent');
  const workspace = new WorkspaceEditorService({
    ownerUserId: 'owner-1',
    owner: {
      load: async (ref) => {
        loaded.push(ref);
        if (loaded.length > 1) throw missing;
      },
      importContent: async () => assert.fail('read imported a file'),
    },
    readSource: async () => assert.fail('read touched the source file'),
    bindings: { bind: async () => assert.fail('read created a binding') },
  });
  const ref = await workspace.resolveExisting({ worktreeId: 'wt', path: 'sample.docx' });
  assert.match(ref, /^workspace-docx:[a-f0-9]{64}$/);
  assert.deepEqual(loaded, [ref]);
  await assert.rejects(
    workspace.resolveExisting({ worktreeId: 'wt', path: 'absent.docx' }),
    (error) => error === missing,
  );
  for (const path of ['../sample.docx', '/sample.docx', 'dir/./sample.docx', 'sample.xlsx', 'dir\\sample.docx'])
    await assert.rejects(workspace.resolveExisting({ worktreeId: 'wt', path }), /UNSUPPORTED_FORMAT/);
  assert.equal(loaded.length, 2, 'invalid locators must be rejected before owner access');
});
