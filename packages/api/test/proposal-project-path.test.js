// @ts-check
/**
 * F128 projectPath ownership contract — propose + approve (route-level, in-memory store).
 *
 * Root cause this pins: a child thread created with projectPath `default` has no project
 * ownership, so cats invoked in it fall back to the runtime process cwd (the sanctuary).
 * The fix lets the cat pin projectPath at propose time and the user re-home it at approve
 * time, with fail-loud validation (砚砚 review push-back #1: an invalid explicit path must
 * 400, never silently fall back to source/default).
 *
 * Redis-only finalize persistence (HSET on finalize) is pinned separately in
 * redis-proposal-store-finalize.test.js — the in-memory store mutates the record in place
 * and cannot surface a missing HSET (feedback_inmemory_store_tests_miss_redis_behavior).
 */

import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { describe, test } from 'node:test';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

// `validateProjectPath` canonicalizes via realpath (e.g. /tmp → /private/tmp on macOS),
// so assert against the resolved real path rather than the literal input.
const TMP = '/tmp';
const TMP_CANON = realpathSync(TMP);
const BAD_PATH = '/no/such/dir/f128-does-not-exist';

describe('F128 projectPath — propose side (callback route)', () => {
  test('valid explicit projectPath is stored as the canonical real path', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const res = await ctx.propose({ userId: 'alice', threadId: source.id, body: { projectPath: TMP } });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.projectPath, TMP_CANON);
  });

  test('invalid explicit projectPath fails loud (400) and persists nothing', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const before = ctx.threadStore.size;
    const res = await ctx.propose({ userId: 'alice', threadId: source.id, body: { projectPath: BAD_PATH } });
    assert.equal(res.statusCode, 400);
    const pending = await ctx.proposalStore.listPending('alice');
    assert.equal(pending.length, 0, 'no proposal should be created on invalid path');
    assert.equal(ctx.threadStore.size, before, 'no thread should be created');
  });

  test('omitted projectPath inherits the source thread projectPath', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source', TMP_CANON);
    const res = await ctx.propose({ userId: 'alice', threadId: source.id });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.projectPath, TMP_CANON, 'child proposal inherits source ownership');
  });
});

describe('F128 projectPath — approve side (user route)', () => {
  test('override re-homes the child thread AND syncs the proposal audit to the final path', async () => {
    const ctx = await createProposalTestContext();
    // Source thread has no ownership ('default') — the exact root-cause scenario.
    const source = await ctx.threadStore.create('alice', 'Source', 'default');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    const inherited = await ctx.proposalStore.get(proposalId);
    assert.equal(inherited.projectPath, 'default', 'proposal inherited the default (no-ownership) path');

    const res = await ctx.approve('alice', proposalId, { projectPath: TMP });
    assert.equal(res.statusCode, 200);
    const { threadId } = JSON.parse(res.body);

    const thread = await ctx.threadStore.get(threadId);
    assert.ok(thread);
    assert.equal(thread.projectPath, TMP_CANON, 'created thread is homed to the override (canonical)');
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.projectPath, TMP_CANON, 'proposal audit must not keep the stale default');
  });

  test('invalid override fails loud (400): proposal stays pending, no thread created', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    const before = ctx.threadStore.size;

    const res = await ctx.approve('alice', proposalId, { projectPath: BAD_PATH });
    assert.equal(res.statusCode, 400);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.status, 'pending', 'invalid override must not claim the proposal');
    assert.equal(ctx.threadStore.size, before, 'no thread on invalid override');
  });

  test('no override inherits the proposal projectPath', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source', TMP_CANON);
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const { threadId } = JSON.parse(res.body);
    const thread = await ctx.threadStore.get(threadId);
    assert.ok(thread);
    assert.equal(thread.projectPath, TMP_CANON, 'no override → inherit proposal ownership');
  });

  test('approving a default-parent proposal keeps default but returns an unclassified warning', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source', 'default');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);

    const res = await ctx.approve('alice', proposalId);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.warnings.some((warning) => warning.includes('未分类')));

    const thread = await ctx.threadStore.get(body.threadId);
    assert.ok(thread);
    assert.equal(thread.projectPath, 'default', 'explicitly approving without a project keeps the child unclassified');
  });
});

// 砚砚 review P1-2: spec says projectPath defaults to inherit the PARENT thread. Inheriting the
// source thread instead mounts a re-parented child to the wrong project. (Inheritance copies the
// parent's stored projectPath verbatim — no validateProjectPath — so arbitrary path strings are fine.)
describe('F128 projectPath — inherits the effective parent (not the source)', () => {
  test('propose with explicit parentThreadId inherits the parent projectPath, not the source', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source', '/projects/source-repo');
    const parent = await ctx.threadStore.create('alice', 'Parent', '/projects/parent-repo');
    const res = await ctx.propose({ userId: 'alice', threadId: source.id, body: { parentThreadId: parent.id } });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = await ctx.proposalStore.get(proposalId);
    assert.equal(proposal.projectPath, '/projects/parent-repo', 'inherit effective parent, not source');
  });

  test('approve re-parent (no projectPath override) re-homes to the new parent ownership', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source', '/projects/source-repo');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    const newParent = await ctx.threadStore.create('alice', 'New Parent', '/projects/new-parent-repo');
    const res = await ctx.approve('alice', proposalId, { parentThreadId: newParent.id });
    assert.equal(res.statusCode, 200);
    const { threadId } = JSON.parse(res.body);
    const thread = await ctx.threadStore.get(threadId);
    assert.ok(thread);
    assert.equal(thread.projectPath, '/projects/new-parent-repo', 're-parent re-inherits new parent ownership');
  });

  test('explicit projectPath override beats re-parent inheritance', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source', '/projects/source-repo');
    const { proposalId } = JSON.parse((await ctx.propose({ userId: 'alice', threadId: source.id })).body);
    const newParent = await ctx.threadStore.create('alice', 'New Parent', '/projects/new-parent-repo');
    // Override projectPath AND re-parent: the validated explicit path wins.
    const res = await ctx.approve('alice', proposalId, { parentThreadId: newParent.id, projectPath: TMP });
    assert.equal(res.statusCode, 200);
    const { threadId } = JSON.parse(res.body);
    const thread = await ctx.threadStore.get(threadId);
    assert.ok(thread);
    assert.equal(thread.projectPath, TMP_CANON, 'explicit override wins over re-parent inheritance');
  });
});
