import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { assembleIncrementalContext } from '../src/domains/cats/services/agents/routing/route-helpers.js';
import { DeliveryCursorStore } from '../src/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { setup } from './helpers/f332-roadmap-fixture.js';

test('binds the original roadmap in current-thread metadata and exposes its version directly in the directory', async (t) => {
  const f = await setup(t);
  const result = await f.bind();
  assert.equal(result.statusCode, 200, result.body);
  const binding = f.threadStore.get(f.thread.id)?.threadMetadata?.roadmap;
  assert.equal(binding?.state, 'active');
  assert.equal(binding?.revision, 1);
  assert.equal(binding?.boundBy, 'codex61-sol');
  const roadmap = (await f.directory()).roadmap;
  assert.equal(roadmap.status, 'available');
  assert.equal(roadmap.version.commit, f.git('log', '-1', '--format=%H', '--', 'docs/roadmap.md'));
  assert.equal(roadmap.version.branch, 'main');
  assert.equal(roadmap.documentUpdated, '2026-10-20（候选）');
  assert.equal(roadmap.drillDown.tool, 'cat_cafe_read_file_slice');
  assert.match(await readFile(roadmap.drillDown.args.path, 'utf8'), /Keep the accepted decision/);
  assert.equal('content' in roadmap, false);
  assert.equal('version' in (binding ?? {}), false);
  assert.equal(result.json().roadmap.status, 'available');
});

test('revocation leaves a durable tombstone and stale writers cannot overwrite it or title', async (t) => {
  const f = await setup(t);
  assert.equal((await f.bind()).statusCode, 200);
  const revoked = await f.post({ state: 'revoked', sourceRef: f.sourceRef, expectedRevision: 1 });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((await f.directory()).roadmap.status, 'revoked');
  assert.equal(f.threadStore.get(f.thread.id)?.threadMetadata?.roadmap?.path, 'docs/roadmap.md');
  const stale = await f.post(
    { state: 'active', projectPath: f.root, path: 'docs/roadmap.md', sourceRef: f.sourceRef, expectedRevision: 1 },
    { title: 'must not change' },
  );
  assert.equal(stale.statusCode, 409);
  assert.equal(f.threadStore.get(f.thread.id)?.title, f.thread.title);
});

test('distinguishes missing file, unavailable root, dirty file, and newer activity without declaring it obsolete', async (t) => {
  const f = await setup(t);
  assert.equal((await f.bind()).statusCode, 200);
  await writeFile(join(f.root, 'docs/roadmap.md'), '# Modified original\n');
  const dirty = (await f.directory()).roadmap;
  assert.equal(dirty.version.dirty, true);
  assert.equal(dirty.activityAfterDocument, true);
  assert.equal('obsolete' in dirty, false);
  await rename(join(f.root, 'docs/roadmap.md'), join(f.root, 'docs/moved.md'));
  assert.equal((await f.directory()).roadmap.status, 'invalid');
  await rename(f.root, `${f.root}-offline`);
  t.after(() => rm(`${f.root}-offline`, { recursive: true, force: true }));
  assert.equal((await f.directory()).roadmap.status, 'unavailable');
  assert.equal((await f.directory()).roadmap.reason, 'project_unavailable');
});

test('rejects unrecognized projects, traversal, absolute paths, symlink escape and unrelated source messages before writes', async (t) => {
  const f = await setup(t);
  const other = await mkdtemp(join(tmpdir(), 'f332-unowned-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  await writeFile(join(other, 'outside.md'), '# private');
  await symlink(join(other, 'outside.md'), join(f.root, 'docs/escape.md'));
  for (const change of [
    { projectPath: other },
    { path: '../outside.md' },
    { path: join(f.root, 'docs/roadmap.md') },
    { path: 'docs/escape.md' },
    { sourceRef: 'thread:other#missing' },
  ]) {
    const response = await f.post({
      state: 'active',
      projectPath: f.root,
      path: 'docs/roadmap.md',
      sourceRef: f.sourceRef,
      expectedRevision: null,
      ...change,
    });
    assert.ok(response.statusCode >= 400, response.body);
    assert.equal(f.threadStore.get(f.thread.id)?.threadMetadata?.roadmap, undefined);
  }
});

test('agent-key discovery keeps title only; roadmap coordinates require the original metadata invocation authority', async (t) => {
  const f = await setup(t);
  assert.equal((await f.bind()).statusCode, 200);
  const key = await f.agentKeyRegistry.issue(createCatId('codex61-sol'), 'owner', { expiresAt: null });
  const response = await f.app.inject({
    url: '/api/callbacks/list-threads?includeWork=true',
    headers: { 'x-agent-key-secret': key.secret },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes(f.root), false);
  assert.equal(response.body.includes('roadmap.md'), false);
});

test('normalizes a linked worktree binding back to the persistent original and reports file-specific version', async (t) => {
  const f = await setup(t);
  const linked = `${f.root}-linked`;
  f.git('worktree', 'add', '-b', 'feature/qa', linked);
  t.after(() => rm(linked, { recursive: true, force: true }));
  const original = f.git('rev-parse', 'HEAD');
  await writeFile(join(f.root, 'unrelated.txt'), 'later commit elsewhere');
  f.git('add', '.');
  f.git('-c', 'user.name=F332 QA', '-c', 'user.email=f332@example.invalid', 'commit', '-m', 'unrelated later activity');
  const response = await f.post({
    state: 'active',
    projectPath: linked,
    path: 'docs/roadmap.md',
    sourceRef: f.sourceRef,
    expectedRevision: null,
  });
  assert.equal(response.statusCode, 200, response.body);
  const roadmap = (await f.directory()).roadmap;
  assert.equal(roadmap.version.commit, original);
  assert.equal(roadmap.version.branch, 'main');
  assert.equal(roadmap.version.dirty, false);
  assert.equal(roadmap.drillDown.args.path.includes('-linked'), false);
  assert.notEqual(roadmap.projectPath, linked);
});

test('supports a known cross-project original, then suppresses coordinates when that project standing is removed', async (t) => {
  const f = await setup(t);
  const other = await mkdtemp(join(tmpdir(), 'f332-known-project-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  await writeFile(join(other, 'original.md'), '# Other project original\n');
  const otherThread = f.threadStore.create('owner', 'known project', other);
  const bound = await f.post({
    state: 'active',
    projectPath: other,
    path: 'original.md',
    sourceRef: f.sourceRef,
    expectedRevision: null,
  });
  assert.equal(bound.statusCode, 200, bound.body);
  assert.equal((await f.directory()).roadmap.version.commit, null);
  await f.threadStore.softDelete(otherThread.id);
  const lost = (await f.directory()).roadmap;
  assert.deepEqual(lost, { status: 'unavailable', reason: 'project_identity_unverified' });
});

test('the actual opening context renders the original roadmap alongside Task responsibility', async (t) => {
  const f = await setup(t);
  assert.equal((await f.bind()).statusCode, 200);
  f.taskStore.create({
    userId: 'owner',
    threadId: f.thread.id,
    title: 'Original owner responsibility',
    why: '',
    createdBy: 'user',
    ownerCatId: createCatId('sonnet'),
  });
  const context = await assembleIncrementalContext(
    {
      services: {},
      invocationDeps: { threadStore: f.threadStore } as never,
      messageStore: f.messageStore,
      deliveryCursorStore: new DeliveryCursorStore(),
      taskStore: f.taskStore,
    },
    'owner',
    f.thread.id,
    createCatId('codex61-sol'),
  );
  assert.match(context.contextText, /roadmap:.*docs\/roadmap\.md/);
  assert.match(context.contextText, /Original owner responsibility/);
  assert.match(context.contextText, /内容变化待核/);
  assert.match(context.contextText, /责任看原Task/);
  assert.equal(f.taskStore.listByThread(f.thread.id)[0].ownerCatId, 'sonnet');
});

test('two concurrent initial binds admit one revision without erasing unrelated metadata', async (t) => {
  const f = await setup(t);
  await f.threadStore.atomicMergeThreadMetadata(f.thread.id, { notes: { keep: 'original' } });
  const results = await Promise.all([f.bind(), f.bind()]);
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
  assert.equal(f.threadStore.get(f.thread.id)?.threadMetadata?.notes?.keep, 'original');
});

test('an unavailable metadata source leaves opening context usable and roadmap explicitly unknown', async (t) => {
  const f = await setup(t);
  assert.equal((await f.bind()).statusCode, 200);
  f.threadStore.get = () => {
    throw new Error('metadata source unavailable');
  };
  const context = await assembleIncrementalContext(
    {
      services: {},
      invocationDeps: { threadStore: f.threadStore } as never,
      messageStore: f.messageStore,
      deliveryCursorStore: new DeliveryCursorStore(),
    },
    'owner',
    f.thread.id,
    createCatId('codex61-sol'),
  );
  assert.match(context.contextText, /roadmap:.*未知/);
  assert.match(context.contextText, /Use this original roadmap/);
});

test('reading a roadmap cannot execute a project Git fsmonitor command', async (t) => {
  const f = await setup(t);
  await writeFile(join(f.root, '.git/qa-fsmonitor'), '#!/bin/sh\nprintf invoked > .git/qa-fsmonitor-ran\n', {
    mode: 0o755,
  });
  f.git('config', 'core.fsmonitor', '.git/qa-fsmonitor');
  assert.equal((await f.bind()).statusCode, 200);
  await assert.rejects(readFile(join(f.root, '.git/qa-fsmonitor-ran')), { code: 'ENOENT' });
});

test('an invocation restricted to discovery cannot borrow Task or metadata authority through directory composition', async (t) => {
  const f = await setup(t);
  assert.equal((await f.bind()).statusCode, 200);
  f.taskStore.create({
    userId: 'owner',
    threadId: f.thread.id,
    title: 'restricted Task detail',
    why: '',
    createdBy: 'user',
  });
  const auth = await f.registry.create('owner', createCatId('codex61-sol'), f.thread.id, undefined, undefined, {
    mode: 'callback_allowlist',
    allowedCallbackRoutes: ['GET /api/callbacks/list-threads'],
  });
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  assert.equal((await f.app.inject({ url: '/api/callbacks/thread-metadata', headers })).statusCode, 403);
  assert.equal(
    (await f.app.inject({ url: `/api/callbacks/list-tasks?threadId=${f.thread.id}`, headers })).statusCode,
    403,
  );
  const response = await f.app.inject({ url: '/api/callbacks/list-threads?includeWork=true', headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes('restricted Task detail'), false);
  assert.equal(response.body.includes('roadmap.md'), false);
  assert.equal(response.body.includes(f.root), false);
});
