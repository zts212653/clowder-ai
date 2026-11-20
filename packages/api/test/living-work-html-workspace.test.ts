import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId, MAX_HTML_WORK_BYTES, MAX_WORK_COMMAND_BYTES } from '@cat-cafe/shared';
import { htmlCreate, htmlFixture } from './helpers/living-work-html-fixture.js';

const locator = { worktreeId: 'alias', path: 'card.html' };
const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test('Workspace HTML inspect, create and submit retain exact bytes under the same Work', async (t) => {
  const f = await htmlFixture(t);
  const file = join(f.workspaceRoot, locator.path);
  const original = Buffer.from(`\uFEFF<!doctype html>\r\n<p>${'纸团🐾'.repeat(5000)}</p>\r\n`);
  assert.ok(original.length > MAX_WORK_COMMAND_BYTES);
  await writeFile(file, original);
  const inspected = await f.call({ action: 'inspect-source', locator });
  assert.equal(inspected.statusCode, 200, inspected.body);
  const firstSource = { worktreeId: 'registered-root', path: locator.path, expectedSourceRevision: digest(original) };
  assert.deepEqual(JSON.parse(inspected.json().json), {
    source: firstSource,
    mediaType: 'text/html',
    byteLength: original.length,
  });
  const created = await f.call({ ...htmlCreate, source: firstSource });
  assert.equal(created.statusCode, 200, created.body);
  const first = JSON.parse(created.json().json).reference;
  assert.equal(first.ownerRevision, 1);

  const candidate = Buffer.from('\uFEFF<!doctype html>\r\n<p>接着玩🐾</p>\r\n');
  await writeFile(file, candidate);
  const submit = {
    ...htmlCreate,
    action: 'submit',
    contentRef: first.contentRef,
    expectedOwnerRevision: 1,
    operationId: 'workspace-html-v2',
    source: { ...firstSource, expectedSourceRevision: digest(candidate) },
  };
  const stale = await f.call({ ...submit, source: firstSource });
  assert.equal(stale.statusCode, 409, stale.body);
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
  const denied = await f.call(submit, {
    'x-invocation-id': other.invocationId,
    'x-callback-token': other.callbackToken,
  });
  assert.equal(denied.statusCode, 403, denied.body);
  const wrongVersion = await f.call({ ...submit, operationId: 'wrong-work-revision', expectedOwnerRevision: 2 });
  assert.equal(wrongVersion.statusCode, 409, wrongVersion.body);
  const submitted = await f.call(submit);
  assert.equal(submitted.statusCode, 200, submitted.body);
  const second = JSON.parse(submitted.json().json).reference;
  assert.deepEqual(second, { contentRef: first.contentRef, ownerRevision: 2 });

  for (const [reference, bytes] of [
    [first, original],
    [second, candidate],
  ] as const) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/works/command',
      headers: { 'x-fixture-user': 'operator' },
      payload: { threadId: 'thread-cover', command: { action: 'read-body', reference } },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(Buffer.from(response.json().html), bytes);
    const stored = await f.owner.describeRevision(reference.contentRef, reference.ownerRevision);
    assert.equal(stored.blobDigest, digest(bytes));
    assert.match(stored.sourcePublication?.artifactRef ?? '', /^workspace-content:[a-f0-9]{64}$/);
    assert.equal(stored.sourcePublication?.sourceRef, 'workspace:registered-root:card.html');
    assert.equal(stored.sourcePublication?.revision, digest(bytes));
  }

  await unlink(file);
  const replay = await f.call(submit);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(JSON.parse(replay.json().json).reference, second);
  assert.equal((await f.owner.listOutbox(first.contentRef)).length, 2);
});

test('Workspace HTML admits bounded UTF-8 files only from a registered root', async (t) => {
  const f = await htmlFixture(t);
  const outside = join(f.root, 'outside.html');
  const html = Buffer.from('<p>private</p>');
  const oversized = Buffer.alloc(MAX_HTML_WORK_BYTES + 1, 0x61);
  await writeFile(outside, html);
  await symlink(outside, join(f.workspaceRoot, 'linked.html'));
  await writeFile(join(f.workspaceRoot, 'oversized.html'), oversized);
  await writeFile(join(f.workspaceRoot, 'invalid.html'), Buffer.from([0xc3, 0x28]));
  await writeFile(join(f.workspaceRoot, 'nul.html'), Buffer.from('<p>\0</p>'));
  await writeFile(join(f.workspaceRoot, 'blank.html'), '\uFEFF \r\n');
  await writeFile(join(f.workspaceRoot, 'other.txt'), html);
  for (const [worktreeId, path, status] of [
    ['unknown', 'card.html', 404],
    ['alias', outside, 403],
    ['alias', '../outside.html', 403],
    ['alias', 'linked.html', 403],
    ['alias', 'oversized.html', 413],
    ['alias', 'invalid.html', 400],
    ['alias', 'nul.html', 400],
    ['alias', 'blank.html', 400],
    ['alias', 'other.txt', 400],
  ] as const) {
    const result = await f.call({ action: 'inspect-source', locator: { worktreeId, path } });
    assert.equal(result.statusCode, status, `${path}: ${result.body}`);
  }
  // A caller can supply the right digest without inspecting first.
  const result = await f.call({
    ...htmlCreate,
    source: { worktreeId: 'alias', path: 'oversized.html', expectedSourceRevision: digest(oversized) },
  });
  assert.equal(result.statusCode, 413, result.body);
});

test('Workspace HTML mutation during owner storage cannot become the next version', async (t) => {
  const f = await htmlFixture(t);
  const created = await f.call(htmlCreate);
  assert.equal(created.statusCode, 200, created.body);
  const first = JSON.parse(created.json().json).reference;
  const file = join(f.workspaceRoot, locator.path);
  const candidate = Buffer.from('<p>candidate</p>');
  await writeFile(file, candidate);
  const settleStream = f.owner.settleStream.bind(f.owner);
  f.owner.settleStream = (input) => {
    let checks = 0;
    return settleStream({
      ...input,
      authorizeEffect: async () => {
        if (++checks === 2) await writeFile(file, '<p>changed while saving</p>');
        await input.authorizeEffect();
      },
    });
  };
  const submit = {
    ...htmlCreate,
    action: 'submit',
    operationId: 'source-mutated-before-commit',
    contentRef: first.contentRef,
    expectedOwnerRevision: 1,
    source: { ...locator, expectedSourceRevision: digest(candidate) },
  };
  const result = await f.call(submit);
  assert.equal(result.statusCode, 409, result.body);
  assert.deepEqual(result.json(), { error: 'publication_changed' });
  assert.equal((await f.owner.describe(first.contentRef)).currentOwnerRevision, 1);

  f.owner.settleStream = settleStream;
  await writeFile(file, candidate);
  const retried = await f.call(submit);
  assert.equal(retried.statusCode, 200, retried.body);
  assert.deepEqual(JSON.parse(retried.json().json).reference, { contentRef: first.contentRef, ownerRevision: 2 });
});
