import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { formatWorktreeNotice } from '@cat-cafe/shared';
import { fixture, git } from '../../../scripts/lib/worktree-finish-fixture.mjs';
import { mergedNoticeKey } from '../../../scripts/lib/worktree-merged-notices.mjs';
import { PersistedQueueDelivery } from '../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.ts';
import { createDeliverFn } from '../src/infrastructure/scheduler/delivery.ts';
import { WorktreeNoticeStartGuard } from '../src/infrastructure/worktrees/WorktreeNoticeStartGuard.ts';
import { createPersistedQueueFixture } from './helpers/persisted-queue-fixture.ts';

function subject(f) {
  const path = f.make();
  const head = git(path, 'rev-parse', 'HEAD').trim();
  const sourceRef = 'pr:fixture/repo#42';
  git(
    path,
    'config',
    '--worktree',
    'catcafe.lifecycle.origin',
    JSON.stringify({
      threadId: 'thread_original',
      userId: 'owner-user',
      sourceRef: 'task:original',
      role: 'author',
    }),
  );
  const notice = {
    version: 1,
    kind: 'merged-unfinished',
    path,
    head,
    sourceRef,
    threadId: 'thread_original',
    userId: 'owner-user',
    owner: 'codex61-sol',
    ownerAction: 'queued',
    key: mergedNoticeKey(f.repo, path, head, 'codex61-sol', sourceRef, head),
    reason: 'busy worktree: cwd pid=fixture',
  };
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env node\nconst h=${JSON.stringify(head)};const a=process.argv.slice(2);if(a[0]==='repo')console.log('fixture/repo');else if(a.includes('--paginate'))console.log(h);else console.log(JSON.stringify({base:{repo:{full_name:'fixture/repo'}},state:'closed',merged:true,head:{sha:h},merge_commit_sha:h,commits:1,html_url:'https://github.com/fixture/repo/pull/42'}));`,
  );
  chmodSync(gh, 0o700);
  const env = { PATH: `${bin}:${process.env.PATH}`, CAT_CAFE_DATA_DIR: join(f.root, 'data') };
  const release = () =>
    f.finish(path, {
      sourceRef: 'task:original',
      mergedPr: sourceRef,
      readPr: () => ({ sourceRef, state: 'MERGED', mergedAt: head, commits: [head] }),
    });
  return { notice, env, release };
}

test('a persisted busy reminder is canceled by the actual Queue after its exact checkout is released', async () => {
  const f = fixture();
  let runtime;
  try {
    const { notice, env, release } = subject(f);
    let guard;
    runtime = createPersistedQueueFixture(undefined, {
      autoDrain: false,
      worktreeNoticeStartGuard: { check: (...args) => guard.check(...args) },
    });
    guard = new WorktreeNoticeStartGuard({
      repoRoot: f.repo,
      scriptRoot: resolve('../..'),
      messageStore: runtime.messages,
      getThread: async () => ({ createdBy: 'owner-user' }),
      queryEnv: env,
    });
    const send = createDeliverFn({
      messageStore: runtime.messages,
      persistedQueueDelivery: new PersistedQueueDelivery({
        messages: runtime.messages,
        queue: runtime.queue,
        progress: async () => 'owned_deferred_busy',
      }),
      socketManager: { broadcastToRoom() {}, emitToUser() {} },
    });
    const input = {
      threadId: notice.threadId,
      userId: notice.userId,
      idempotencyKey: `${notice.key}:owner-queued-v1`,
      targetCatId: notice.owner,
      sourceCategory: 'scheduled',
      privateContent: 'Verify the original checkout and finish it.',
      content: formatWorktreeNotice(notice),
      source: {
        connector: 'worktree-lifecycle',
        label: '工位通知',
        icon: 'settings',
        meta: { worktreeNotice: notice },
      },
    };
    await send(input);
    const old = runtime.queue.list(notice.threadId, notice.userId)[0];
    assert.ok(old);
    assert.deepEqual(await guard.check(old, notice.owner), { ok: true }, 'a live checkout still needs its owner');
    const removed = release();
    assert.equal(existsSync(notice.path), false);
    assert.ok(existsSync(join(removed.archivePath, 'manifest.json')));
    assert.deepEqual(await guard.check(old, notice.owner), { ok: false, reason: 'notice_stale' });
    await runtime.processor.processNext(notice.threadId, notice.userId);
    const deadline = Date.now() + 3000;
    while (runtime.queue.getEntrySnapshot(notice.threadId, notice.userId, old.id) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(runtime.starts.length, 0, 'the owner must not be woken for an already-completed release');
    assert.equal(await runtime.queue.getDurableEntry(notice.threadId, old.id), null);
    assert.equal(runtime.messages.getByThread(notice.threadId, 100, notice.userId).length, 1, 'History is retained');
    await send(input);
    assert.equal(runtime.queue.list(notice.threadId, notice.userId).length, 0, 'replay cannot recreate canceled work');
  } finally {
    await runtime?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a stale collected merged subject consumes its verified release through the retirement CLI', () => {
  const f = fixture();
  try {
    const { notice, env, release } = subject(f);
    const removed = release();
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [
          resolve('../../scripts/worktree-retire-merged.mjs'),
          f.repo,
          notice.path,
          notice.head,
          notice.sourceRef,
          notice.threadId,
          notice.userId,
          notice.owner,
          notice.key,
        ],
        { encoding: 'utf8', env: { ...process.env, ...env } },
      ),
    );
    assert.equal(output.state, 'released');
    assert.equal(output.storageDisposition, 'removed');
    assert.equal(output.archivePath, removed.archivePath);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('paused and interrupted recovery reminders remain actionable after normal release revalidation', async () => {
  const f = fixture();
  try {
    const { notice, env, release } = subject(f);
    const removed = release();
    for (const kind of ['merged-retirement-blocked', 'merged-removal-interrupted']) {
      const message = {
        threadId: notice.threadId,
        userId: notice.userId,
        timestamp: Date.now(),
        from: { kind: 'system', service: 'worktree-lifecycle' },
        source: {
          connector: 'worktree-lifecycle',
          meta: { worktreeNotice: { ...notice, kind, archivePath: removed.archivePath } },
        },
      };
      const guard = new WorktreeNoticeStartGuard({
        repoRoot: f.repo,
        scriptRoot: resolve('../..'),
        messageStore: { getByIdempotencyKey: async () => message },
        getThread: async () => ({ createdBy: notice.userId }),
        queryEnv: env,
      });
      const entry = {
        kind: 'private_input',
        threadId: notice.threadId,
        from: message.from,
        owner: { kind: 'user', userId: notice.userId },
        targets: [notice.owner],
        payload: { sourceRecordId: `${notice.key}:owner-queued-v1:private` },
      };
      assert.deepEqual(await guard.check(entry, notice.owner), { ok: true });
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
