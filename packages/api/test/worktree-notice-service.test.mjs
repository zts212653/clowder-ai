import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { removeFinishedWorktree } from '../../../scripts/lib/worktree-direct-release.mjs';
import { fixture, git } from '../../../scripts/lib/worktree-finish-fixture.mjs';
import { lifecycleConfig } from '../../../scripts/lib/worktree-reaper-probes.mjs';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { PersistedQueueDelivery } from '../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.ts';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { createDeliverFn } from '../src/infrastructure/scheduler/delivery.ts';
import { WorktreeNoticeService } from '../src/infrastructure/worktrees/WorktreeNoticeService.ts';

function queryEnv(f, head = null) {
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const executable = join(bin, 'gh');
  writeFileSync(
    executable,
    `#!/usr/bin/env node\nconst args=process.argv.slice(2);\nconst h=${JSON.stringify(head)};\nif(args[0]==='repo')console.log('fixture/repo');else if(args.some(x=>x.endsWith('/pulls')))console.log('[]');else if(args.includes('--paginate'))console.log(h);else console.log(JSON.stringify({base:{repo:{full_name:'fixture/repo'}},state:'closed',merged:true,head:{sha:h},merge_commit_sha:h,commits:1,html_url:'https://github.com/fixture/repo/pull/42'}));`,
  );
  chmodSync(executable, 0o700);
  return { PATH: `${bin}:${process.env.PATH}`, CAT_CAFE_DATA_DIR: join(f.root, 'data') };
}
function expired(f) {
  const p = f.make('expired');
  const head = git(p, 'rev-parse', 'HEAD').trim();
  git(
    p,
    'config',
    '--worktree',
    'catcafe.lifecycle.origin',
    JSON.stringify({ threadId: 'thread_original', userId: 'owner-user', sourceRef: 'task:original', role: 'author' }),
  );
  git(
    p,
    'config',
    '--worktree',
    'catcafe.lifecycle.retention',
    JSON.stringify({
      head,
      owner: 'codex61-sol',
      sourceRef: 'task:original',
      reason: 'awaiting original review',
      recordedAt: '2026-01-01T00:00:00Z',
      until: '2026-01-02T00:00:00Z',
    }),
  );
  return p;
}
function ownerDelivery(messages) {
  const queue = new InvocationQueue(new InMemoryQueueLedgerStore(), { resolveTargets: async (ids) => [...ids] });
  return new PersistedQueueDelivery({ messages, queue, progress: async () => 'owned_deferred_busy' });
}
test('unhandled retention reaches its original owner once through atomic History and Queue delivery', async () => {
  const f = fixture();
  try {
    const p = expired(f);
    const messages = new MessageStore();
    const queue = new InvocationQueue(new InMemoryQueueLedgerStore(), { resolveTargets: async (ids) => [...ids] });
    const sent = [];
    const deliver = createDeliverFn({
      messageStore: messages,
      persistedQueueDelivery: new PersistedQueueDelivery({
        messages,
        queue,
        progress: async () => 'owned_deferred_busy',
      }),
      socketManager: { broadcastToRoom: (...args) => sent.push(args), emitToUser() {} },
    });
    const service = new WorktreeNoticeService({
      repoRoot: f.repo,
      queryEnv: queryEnv(f),
      scriptRoot: resolve('../..'),
      isOwnerAvailable: () => true,
      getThread: async (id) => (id === 'thread_original' ? { createdBy: 'owner-user' } : null),
      deliver,
      warn: () => {},
    });
    await service.sweep();
    await service.sweep();
    const rows = messages.getByThread('thread_original', 100, 'owner-user');
    assert.equal(rows.length, 1);
    const actions = queue.list('thread_original', 'owner-user');
    assert.equal(actions.length, 1, 'a visible reminder must have original-owner work behind it');
    assert.deepEqual(actions[0].targets, ['codex61-sol']);
    assert.equal(rows[0].source.meta.worktreeNotice.ownerAction, 'queued');
    assert.equal(rows[0].source.meta.worktreeNotice.kind, 'retention-expired');
    assert.match(rows[0].content, /保留期已结束/);
    assert.match(rows[0].content, /codex61-sol/);
    assert.equal(rows[0].mentions.length, 0);
    assert.equal(rows[0].from.kind, 'system');
    assert(sent.length > 0);
    const r = JSON.parse(git(p, 'config', '--worktree', '--get', 'catcafe.lifecycle.retention'));
    r.until = '2099-01-02T00:00:00Z';
    r.recordedAt = '2099-01-01T00:00:00Z';
    git(p, 'config', '--worktree', 'catcafe.lifecycle.retention', JSON.stringify(r));
    await service.sweep();
    assert.equal(messages.getByThread('thread_original', 100, 'owner-user').length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('wrong-user thread and corrupt provenance never deliver or reroute', async () => {
  const f = fixture();
  try {
    const p = expired(f);
    let attempts = 0;
    const warnings = [];
    const service = new WorktreeNoticeService({
      repoRoot: f.repo,
      queryEnv: queryEnv(f),
      scriptRoot: resolve('../..'),
      isOwnerAvailable: () => true,
      getThread: async () => ({ createdBy: 'other-user' }),
      deliver: async () => {
        attempts++;
        return 'id';
      },
      warn: (m) => warnings.push(m),
    });
    await service.sweep();
    assert.equal(attempts, 0);
    assert(warnings.length > 0);
    git(p, 'config', '--worktree', 'catcafe.lifecycle.origin', 'broken-json');
    await service.sweep();
    assert.equal(attempts, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('unavailable and scarce owners leave one visible exception without automatic wake', async () => {
  for (let [available, scarce] of [
    [false, false],
    [true, true],
  ]) {
    const f = fixture();
    try {
      const p = expired(f);
      if (scarce) git(p, 'config', '--worktree', 'catcafe.lifecycle.owner', 'fable-5');
      const messages = new MessageStore();
      const queue = new InvocationQueue(new InMemoryQueueLedgerStore(), { resolveTargets: async (ids) => [...ids] });
      const delivery = createDeliverFn({
        messageStore: messages,
        socketManager: { broadcastToRoom() {}, emitToUser() {} },
        persistedQueueDelivery: new PersistedQueueDelivery({
          messages,
          queue,
          progress: async () => 'owned_deferred_busy',
        }),
      });
      const deps = {
        repoRoot: f.repo,
        scriptRoot: resolve('../..'),
        queryEnv: queryEnv(f),
        getThread: async () => ({ createdBy: 'owner-user' }),
        isOwnerAvailable: () => available,
        getEngagementPolicy: () => (scarce ? { quota: 'weekly_subscription_scarce' } : undefined),
        deliver: delivery,
        warn: () => {},
      };
      const service = new WorktreeNoticeService(deps);
      for (let i = 0; i < 4; i++) await service.sweep();
      const notices = messages.getByThread('thread_original', 100, 'owner-user');
      assert.equal(notices.length, 1, 'an unavailable owner must not make unresolved cleanup invisible');
      assert.equal(notices[0].source.meta.worktreeNotice.ownerAction, 'unavailable');
      assert.match(notices[0].content, /未排入负责人待办/);
      assert.equal(queue.list('thread_original', 'owner-user').length, 0, 'unavailable or scarce owners are not woken');
      available = true;
      scarce = false;
      const resumed = new WorktreeNoticeService(deps);
      await resumed.sweep();
      await resumed.sweep();
      assert.equal(
        messages.getByThread('thread_original', 100, 'owner-user').length,
        2,
        'availability recovery is a distinct fact',
      );
      assert.equal(
        queue.list('thread_original', 'owner-user').length,
        1,
        'restarting the service admits owner work once',
      );
      assert(existsSync(p));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('failed atomic Queue admission cannot publish a claim that owner work was queued', async () => {
  const f = fixture();
  try {
    const p = expired(f);
    const messages = new MessageStore();
    const service = new WorktreeNoticeService({
      repoRoot: f.repo,
      scriptRoot: resolve('../..'),
      queryEnv: queryEnv(f),
      getThread: async () => ({ createdBy: 'owner-user' }),
      isOwnerAvailable: () => true,
      getEngagementPolicy: () => undefined,
      deliver: createDeliverFn({
        messageStore: messages,
        socketManager: { broadcastToRoom() {}, emitToUser() {} },
        persistedQueueDelivery: {
          deliverVisibleWithPrivateInput: async () => {
            throw new Error('Queue unavailable');
          },
        },
      }),
      warn: () => {},
    });
    await service.sweep();
    assert.equal(messages.getByThread('thread_original', 100, 'owner-user').length, 0);
    assert(existsSync(p));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('periodic service retires a merged checkout, preserves private originals and keeps its branch', async () => {
  const f = fixture();
  try {
    const p = f.make('review');
    const head = git(p, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(p, '.env.local'), 'PRIVATE_FIXTURE_VALUE=local-only\n');
    mkdirSync(join(p, 'node_modules'));
    writeFileSync(join(p, 'node_modules', 'regenerable'), 'dependency');
    git(
      p,
      'config',
      '--worktree',
      'catcafe.lifecycle.origin',
      JSON.stringify({
        threadId: 'thread_original',
        userId: 'owner-user',
        sourceRef: 'pr:fixture/repo#42',
        role: 'review',
      }),
    );
    const messages = new MessageStore();
    const deliverToHistory = createDeliverFn({
      messageStore: messages,
      socketManager: { broadcastToRoom() {}, emitToUser() {} },
    });
    let failDelivery = true;
    const deliver = async (opts) => {
      if (failDelivery) {
        failDelivery = false;
        throw new Error('transient History interruption');
      }
      return deliverToHistory(opts);
    };
    const warnings = [];
    const service = new WorktreeNoticeService({
      repoRoot: f.repo,
      scriptRoot: resolve('../..'),
      queryEnv: queryEnv(f, head),
      isOwnerAvailable: () => true,
      getThread: async () => ({ createdBy: 'owner-user' }),
      deliver,
      warn: (m) => warnings.push(m),
    });
    await service.sweep();
    assert.equal(existsSync(p), false, 'merged idle checkout must actually be removed');
    assert.equal(git(f.repo, 'rev-parse', 'test/review').trim(), head);
    const lines = readFileSync(join(f.root, '.reaper-quarantine', 'ledger.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    const done = lines.find((row) => row.state === 'done' && row.from === p);
    assert.equal(done.performedBy, 'worktree-lifecycle');
    assert.equal(
      readFileSync(join(done.archivePath, 'files', '.env.local'), 'utf8'),
      'PRIVATE_FIXTURE_VALUE=local-only\n',
    );
    assert.equal(existsSync(join(done.archivePath, 'files', 'node_modules')), false);
    assert.equal(
      messages.getByThread('thread_original', 100, 'owner-user').length,
      0,
      'first delivery failed after actual removal',
    );
    await service.sweep();
    assert.equal(
      messages.getByThread('thread_original', 100, 'owner-user')[0].source.meta.worktreeNotice.kind,
      'merged-removed',
    );
    await service.sweep();
    assert.equal(messages.getByThread('thread_original', 100, 'owner-user').length, 1);
    assert.equal(warnings.length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a new sweep reports a removed checkout whose automatic completion receipt was interrupted', async () => {
  const f = fixture();
  try {
    const p = f.make('interrupted');
    const head = git(p, 'rev-parse', 'HEAD').trim();
    git(
      p,
      'config',
      '--worktree',
      'catcafe.lifecycle.origin',
      JSON.stringify({
        threadId: 'thread_original',
        userId: 'owner-user',
        sourceRef: 'pr:fixture/repo#42',
        role: 'author',
      }),
    );
    writeFileSync(join(p, '.env.local'), 'PRIVATE_FIXTURE_VALUE=original\n');
    const env = queryEnv(f, head);
    execFileSync(
      process.execPath,
      [
        resolve('../../scripts/worktree-retire-merged.mjs'),
        f.repo,
        p,
        head,
        'pr:fixture/repo#42',
        'thread_original',
        'owner-user',
        'codex61-sol',
      ],
      { env: { ...process.env, ...env } },
    );
    assert.equal(existsSync(p), false);
    const ledger = join(f.root, '.reaper-quarantine/ledger.jsonl');
    const pending = readFileSync(ledger, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((r) => r.state !== 'done');
    writeFileSync(ledger, `${pending.map(JSON.stringify).join('\n')}\n`);
    const messages = new MessageStore();
    const service = new WorktreeNoticeService({
      repoRoot: f.repo,
      scriptRoot: resolve('../..'),
      queryEnv: env,
      isOwnerAvailable: () => true,
      getThread: async () => ({ createdBy: 'owner-user' }),
      deliver: createDeliverFn({
        messageStore: messages,
        persistedQueueDelivery: ownerDelivery(messages),
        socketManager: { broadcastToRoom() {}, emitToUser() {} },
      }),
      warn: () => {},
    });
    await service.sweep();
    const rows = messages.getByThread('thread_original', 100, 'owner-user');
    assert.equal(rows.length, 1, 'pending-only removal must reach its original History');
    assert.match(rows[0].content, /中断/);
    const notice = rows[0].source.meta.worktreeNotice;
    assert.equal(notice.kind, 'merged-removal-interrupted');
    assert.equal(existsSync(notice.archivePath), true);
    assert.match(notice.restore, /worktree add/);
    await service.sweep();
    assert.equal(messages.getByThread('thread_original', 100, 'owner-user').length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('failed automatic retirement pauses repeated sweeps and reports the original thread once', async () => {
  const f = fixture();
  try {
    const p = f.make('aborted');
    const head = git(p, 'rev-parse', 'HEAD').trim();
    git(
      p,
      'config',
      '--worktree',
      'catcafe.lifecycle.origin',
      JSON.stringify({
        threadId: 'thread_original',
        userId: 'owner-user',
        sourceRef: 'pr:fixture/repo#42',
        role: 'author',
      }),
    );
    writeFileSync(join(p, '.env.local'), 'PRIVATE_FIXTURE_VALUE=still-here\n');
    assert.throws(
      () =>
        removeFinishedWorktree({
          repo: f.repo,
          root: join(f.root, '.reaper-quarantine'),
          actor: 'worktree-lifecycle',
          authorizationRef: 'pr:fixture/repo#42',
          entry: {
            path: p,
            head,
            lifecycle: lifecycleConfig(p, '--worktree'),
            finishSourceRef: 'pr:fixture/repo#42',
            mergedPr: 'pr:fixture/repo#42',
            mergedAt: head,
          },
          validate() {
            throw new Error('late consumer');
          },
        }),
      /late consumer/,
    );
    const messages = new MessageStore();
    const service = new WorktreeNoticeService({
      repoRoot: f.repo,
      scriptRoot: resolve('../..'),
      queryEnv: queryEnv(f, head),
      isOwnerAvailable: () => true,
      getThread: async () => ({ createdBy: 'owner-user' }),
      deliver: createDeliverFn({
        messageStore: messages,
        persistedQueueDelivery: ownerDelivery(messages),
        socketManager: { broadcastToRoom() {}, emitToUser() {} },
      }),
      warn: () => {},
    });
    for (let i = 0; i < 3; i++) await service.sweep();
    assert.equal(existsSync(p), true);
    const rows = readFileSync(join(f.root, '.reaper-quarantine/ledger.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(rows.filter((r) => r.state === 'pending').length, 1, 'sweeps must not create new transactions');
    const sent = messages.getByThread('thread_original', 100, 'owner-user');
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /已暂停/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
