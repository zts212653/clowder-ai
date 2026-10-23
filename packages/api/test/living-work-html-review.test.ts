import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { isHtmlWorkSource, openHtmlWorkSource } from '../src/domains/collaborative-content/works/html-source.js';
import { LivingWorkService } from '../src/domains/collaborative-content/works/service.js';
import { validateContentPublication } from '../src/domains/video-studio/content-owner/publication.js';
import type { WorkPublicationScopeV1 } from '../src/domains/video-studio/content-owner/types.js';
import { htmlCreate, htmlFixture } from './helpers/living-work-html-fixture.js';

const scope: WorkPublicationScopeV1 = {
  kind: 'work',
  ownerUserId: 'operator',
  threadId: 'thread-cover',
  creationOperationId: 'html-v1',
  createdBy: { kind: 'cat', actorId: 'codex-astra' },
};
const inline = {
  artifactRef: 'inline-html',
  sourceRef: 'inline-html',
  revision: `sha256:${'a'.repeat(64)}`,
  threadId: scope.threadId,
};
const workspace = { ...inline, artifactRef: 'movie.mp4', sourceRef: 'workspace:root:movie.mp4' };

test('work provenance binds inline HTML to text/html and Workspace to existing media formats', async (t) => {
  assert.doesNotThrow(() => validateContentPublication(scope, inline, 'text/html'));
  assert.throws(() => validateContentPublication(scope, workspace, 'text/html'), /Invalid work publication/);
  for (const mediaType of ['image/png', 'image/jpeg', 'image/webp', 'video/mp4']) {
    assert.doesNotThrow(() => validateContentPublication(scope, workspace, mediaType));
    assert.throws(() => validateContentPublication(scope, inline, mediaType), /Invalid work publication/);
  }
  assert.throws(() => validateContentPublication(scope, workspace, 'text/plain'), /Invalid work publication/);
  assert.throws(
    () => validateContentPublication(scope, { ...inline, artifactRef: 'movie.mp4' }, 'text/html'),
    /Invalid work publication/,
  );
  const f = await htmlFixture(t);
  const source = openHtmlWorkSource(htmlCreate.source);
  await assert.rejects(
    f.owner.importStream({
      ...source,
      contentRef: 'work:mislabelled-media',
      operationId: 'mislabelled-media',
      actor: f.principal.actor,
      mediaType: 'video/mp4',
      publicationScope: scope,
      sourcePublication: { ...source.publication, threadId: scope.threadId },
      authorizeEffect: async () => undefined,
    }),
    /Invalid work publication/,
  );
  assert.equal(source.stream.destroyed, true);
  await assert.rejects(f.owner.describe('work:mislabelled-media'), /not found/i);
});

test('HTML source selection checks the explicit tag rather than the existence of kind', () => {
  assert.equal(isHtmlWorkSource(htmlCreate.source), true);
  const locator = { worktreeId: 'root', path: 'movie.mp4', expectedSourceRevision: inline.revision };
  assert.equal(isHtmlWorkSource(locator), false);
  const futureWorkspace = { ...locator, kind: 'workspace' };
  assert.equal(isHtmlWorkSource(futureWorkspace), false);
});

test('an internally imported invalid UTF-8 body maps to media_unavailable through the real HTTP read', async (t) => {
  const f = await htmlFixture(t);
  const first = await f.service.commit(htmlCreate, f.principal);
  // Internal stream imports can carry bytes that never passed the public HTML string schema.
  const bytes = Buffer.from([0xc3, 0x28]);
  const blobDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
  const receipt = await f.owner.settleStream({
    contentRef: first.reference.contentRef,
    operationId: 'internal-invalid-utf8',
    expectedOwnerRevision: 1,
    actor: f.principal.actor,
    stream: Readable.from([bytes]),
    byteLength: bytes.length,
    blobDigest,
    sourcePublication: { ...inline, revision: blobDigest },
    authorizeEffect: async () => undefined,
  });
  const version = f.store.works.get('operator', first.reference.contentRef, 1);
  assert.ok(version);
  f.store.works.recordVersion({
    ...version,
    ownerRevision: 2,
    operationId: receipt.operationId,
    receiptRef: receipt.receiptId,
  });
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/works/command',
    headers: { 'x-fixture-user': 'operator' },
    payload: {
      threadId: 'thread-cover',
      command: { action: 'read-body', reference: { ...first.reference, ownerRevision: 2 } },
    },
  });
  assert.equal(response.statusCode, 503, response.body);
  assert.deepEqual(response.json(), { error: 'media_unavailable' });
});

test('body reads authorize the exact scope before and after IO without loading full revision metadata twice', async (t) => {
  const f = await htmlFixture(t);
  const first = await f.service.commit(htmlCreate, f.principal);
  const events: string[] = [];
  const open = f.owner.open.bind(f.owner);
  f.owner.open = async (...args) => {
    events.push('body');
    return open(...args);
  };
  f.owner.describeRevision = async () => {
    throw new Error('body reads must not fetch full revision metadata');
  };
  const service = new LivingWorkService({
    ...f.deps,
    authorize: async (input) => {
      assert.equal(input.permission, 'read');
      assert.deepEqual(input.scope, scope);
      events.push('authorize');
      await f.deps.authorize(input);
    },
  });
  assert.equal((await service.readBody(first.reference, f.principal)).html, htmlCreate.source.html);
  assert.deepEqual(events, ['authorize', 'body', 'authorize']);
});
