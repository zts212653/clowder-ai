import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { LivingWorkService } from '../src/domains/collaborative-content/works/service.js';
import { MediaOwnerError } from '../src/domains/video-studio/content-owner/media-errors.js';
import { htmlCreate, htmlFixture } from './helpers/living-work-html-fixture.js';

const readBody = (reference: { contentRef: string; ownerRevision: number }) => ({ action: 'read-body', reference });

test('HTTP and callback create/read the same fixed owner body; callback pagination is complete, silent and no-store', async (t) => {
  const f = await htmlFixture(t);
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/works/command',
    headers: { 'x-fixture-user': 'operator' },
    payload: {
      threadId: 'thread-cover',
      command: { ...htmlCreate, source: { kind: 'html', html: '<p>"\\\n🐾</p>'.repeat(700) } },
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  const reference = created.json().reference;
  let json = '',
    cursor = 0,
    expectedSnapshot: string | undefined;
  let pages = 0;
  do {
    const response = await f.call(readBody(reference), f.headers, { cursor, expectedSnapshot });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.headers['content-type'] ?? '', /application\/json/);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.ok(response.body.length <= 12000);
    const page = response.json();
    json += page.json;
    pages++;
    expectedSnapshot = page.snapshot;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  } while (cursor > 0);
  assert.ok(pages > 1);
  assert.equal(JSON.parse(json).html, '<p>"\\\n🐾</p>'.repeat(700));
  assert.equal(
    (await f.call(readBody(reference), f.headers, { cursor: 1, expectedSnapshot: `sha256:${'f'.repeat(64)}` }))
      .statusCode,
    409,
  );
  assert.equal(f.messages.size, 0);
  assert.equal((await f.call({ action: 'read', reference })).json().json.includes('<p>'), false);
});

test('HTML keeps actual producer authority: missing credentials, foreign owner, non-strict/readonly/completed invocation and foreign writers are rejected', async (t) => {
  const f = await htmlFixture(t);
  assert.equal((await f.call(htmlCreate, {})).statusCode, 401);
  for (const strict of [false, true]) {
    const auth = await f.registry.create(
      'operator',
      createCatId(strict ? 'kimi' : 'codex-sol'),
      'thread-cover',
      undefined,
      undefined,
      strict ? { mode: 'read_only', replayDeniedToolNames: [] } : undefined,
      undefined,
      strict ? 'strict' : 'unknown',
    );
    assert.equal(
      (await f.call(htmlCreate, { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken }))
        .statusCode,
      403,
    );
  }
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/works/command',
        headers: { 'x-fixture-user': 'foreign' },
        payload: { threadId: 'thread-cover', command: htmlCreate },
      })
    ).statusCode,
    403,
  );
  const first = await f.service.commit(htmlCreate, f.principal);
  const other = await f.registry.create(
    'operator',
    createCatId('codex-sol'),
    'thread-cover',
    undefined,
    undefined,
    undefined,
    undefined,
    'strict',
  );
  const response = await f.call(
    {
      ...htmlCreate,
      action: 'submit',
      contentRef: first.reference.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'foreign-writer',
      source: { kind: 'html', html: '<p>overwrite</p>' },
    },
    { 'x-invocation-id': other.invocationId, 'x-callback-token': other.callbackToken },
  );
  assert.equal(response.statusCode, 403, response.body);
  await f.registry.commitTerminal({
    invocationId: f.credentials.invocationId,
    disposition: 'completed',
    endedAt: Date.now(),
    endReason: 'test producer finished',
  });
  assert.equal((await f.call(readBody(first.reference))).statusCode, 401);
  assert.equal((await f.owner.describe(first.reference.contentRef)).currentOwnerRevision, 1);
});

test('hidden/deleted owning thread never leaks list, body, replay or an existence difference', async (t) => {
  const f = await htmlFixture(t);
  const first = await f.service.commit(htmlCreate, f.principal);
  assert.ok(f.thread.current);
  const original = { ...f.thread.current };
  for (const mutation of [{ createdBy: 'foreign' }, { deletedAt: Date.now() }]) {
    f.thread.current = { ...original, ...mutation };
    const actual = await f.call(readBody(first.reference));
    const missing = await f.call(readBody({ contentRef: 'work:missing', ownerRevision: 1 }));
    assert.equal(actual.statusCode, 403, actual.body);
    assert.equal(missing.statusCode, actual.statusCode);
    assert.deepEqual(actual.json(), missing.json());
    assert.equal((await f.call({ action: 'list' })).statusCode, 403);
    assert.equal((await f.call(htmlCreate)).statusCode, 403);
    assert.ok(!actual.body.includes(first.reference.contentRef));
  }
  f.thread.current = original;
  const foreign = await f.app.inject({
    method: 'POST',
    url: '/api/works/command',
    headers: { 'x-fixture-user': 'foreign' },
    payload: { threadId: 'thread-cover', command: readBody(first.reference) },
  });
  assert.equal(foreign.statusCode, 403);
});

test('same cat in a different thread cannot use a handle as a grant; another authorized invocation in the same thread can read', async (t) => {
  const f = await htmlFixture(t);
  const first = await f.service.commit(htmlCreate, f.principal);
  const again = await f.registry.create(
    'operator',
    createCatId('codex-astra'),
    'thread-cover',
    undefined,
    undefined,
    undefined,
    undefined,
    'strict',
  );
  const headers = { 'x-invocation-id': again.invocationId, 'x-callback-token': again.callbackToken };
  assert.equal((await f.call(readBody(first.reference), headers)).statusCode, 200);
  const elsewhere = await f.registry.create(
    'operator',
    createCatId('codex-astra'),
    'other-thread',
    undefined,
    undefined,
    undefined,
    undefined,
    'strict',
  );
  assert.equal(
    (
      await f.call(
        readBody(first.reference),
        { 'x-invocation-id': elsewhere.invocationId, 'x-callback-token': elsewhere.callbackToken },
        { contentTaskId: 'invented-grant' },
      )
    ).statusCode,
    403,
  );
});

test('revocation during body IO is rechecked before returning any body', async (t) => {
  const f = await htmlFixture(t);
  const first = await f.service.commit(htmlCreate, f.principal);
  const open = f.owner.open.bind(f.owner);
  f.owner.open = async (...args) => {
    const opened = await open(...args);
    assert.ok(f.thread.current);
    f.thread.current.deletedAt = Date.now();
    return opened;
  };
  const response = await f.call(readBody(first.reference));
  assert.equal(response.statusCode, 403, response.body);
  assert.ok(!response.body.includes('button'));
});

test('HTML scripts and external references remain inert source data during save/read, never an HTML response', async (t) => {
  const f = await htmlFixture(t);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('external IO forbidden');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const html =
    '<script>fetch("https://example.invalid/secret"); throw new Error("executed")</script><img src="https://example.invalid/pixel">';
  const saved = await f.service.commit({ ...htmlCreate, source: { kind: 'html', html } }, f.principal);
  const response = await f.call(readBody(saved.reference));
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.headers['content-type'] ?? '', /application\/json/);
  assert.equal(JSON.parse(response.json().json).html, html);
  assert.equal(calls, 0);
});

test('format changes on the same work handle are rejected; HTML read-body cannot materialize MP4', async (t) => {
  const f = await htmlFixture(t);
  const video = Buffer.from('opaque mp4 bytes owned by the existing format adapter');
  const source = {
    worktreeId: 'root',
    path: 'movie.mp4',
    expectedSourceRevision: `sha256:${createHash('sha256').update(video).digest('hex')}`,
  };
  const service = new LivingWorkService({
    ...f.deps,
    source: {
      ...f.deps.source,
      open: async () => ({
        mediaType: 'video/mp4',
        stream: Readable.from([video]),
        byteLength: video.length,
        blobDigest: source.expectedSourceRevision as `sha256:${string}`,
        publication: {
          artifactRef: 'movie.mp4',
          sourceRef: 'workspace:root:movie.mp4',
          revision: source.expectedSourceRevision,
        },
        revalidate: async () => undefined,
      }),
    },
  });
  const film = await service.commit({ ...htmlCreate, operationId: 'video-v1', source }, f.principal);
  await assert.rejects(
    service.readBody(film.reference, f.principal),
    (e: unknown) => e instanceof MediaOwnerError && e.code === 'invalid_media',
  );
  await assert.rejects(
    service.commit(
      {
        ...htmlCreate,
        action: 'submit',
        contentRef: film.reference.contentRef,
        expectedOwnerRevision: 1,
        operationId: 'change-format',
      },
      f.principal,
    ),
    (e: unknown) => e instanceof MediaOwnerError && e.code === 'invalid_media',
  );
  const page = await service.commit(htmlCreate, f.principal);
  await assert.rejects(
    service.commit(
      {
        ...htmlCreate,
        source,
        action: 'submit',
        contentRef: page.reference.contentRef,
        expectedOwnerRevision: 1,
        operationId: 'change-back',
      },
      f.principal,
    ),
    (e: unknown) => e instanceof MediaOwnerError && e.code === 'invalid_media',
  );
});
