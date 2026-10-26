import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fixture, git } from '../../../scripts/lib/worktree-finish-fixture.mjs';
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
  return { PATH: `${bin}:${process.env.PATH}` };
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
test('expired checkout reaches the exact original thread once through real History delivery, without Queue work', async () => {
  const f = fixture();
  try {
    const p = expired(f);
    const messages = new MessageStore();
    const sent = [];
    const deliver = createDeliverFn({
      messageStore: messages,
      socketManager: { broadcastToRoom: (...args) => sent.push(args), emitToUser() {} },
    });
    const service = new WorktreeNoticeService({
      repoRoot: f.repo,
      queryEnv: queryEnv(f),
      scriptRoot: resolve('../..'),
      getThread: async (id) => (id === 'thread_original' ? { createdBy: 'owner-user' } : null),
      deliver,
      warn: () => {},
    });
    await service.sweep();
    await service.sweep();
    const rows = messages.getByThread('thread_original', 100, 'owner-user');
    assert.equal(rows.length, 1);
    assert.match(rows[0].content, /expired/);
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

test('periodic service consumes real CLI post-merge reconciliation and delivers its result', async () => {
  const f = fixture();
  try {
    const p = f.make('review');
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
        role: 'review',
      }),
    );
    const messages = new MessageStore();
    const deliver = createDeliverFn({
      messageStore: messages,
      socketManager: { broadcastToRoom() {}, emitToUser() {} },
    });
    const service = new WorktreeNoticeService({
      repoRoot: f.repo,
      scriptRoot: resolve('../..'),
      queryEnv: queryEnv(f, head),
      getThread: async () => ({ createdBy: 'owner-user' }),
      deliver,
      warn: (m) => {
        throw new Error(m);
      },
    });
    await service.sweep();
    assert.match(messages.getByThread('thread_original', 100, 'owner-user')[0].content, /merged-unfinished/);
    await service.sweep();
    assert.equal(messages.getByThread('thread_original', 100, 'owner-user').length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
