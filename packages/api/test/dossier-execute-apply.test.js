/**
 * F208 AC-E3: execute-apply endpoint integration tests
 *
 * Tests the full pipeline: validate → write → git commit → push → mark applied.
 * Uses a temp directory with a git repo to test file operations safely.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

function hash(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const DOSSIER_CONTENT = `---
feature_id: F208
---

# Clowder AI 能力画像档案

### 布偶猫 Opus 4.6 · @opus · \`cat:opus\`

| ① | **原生峰值** | 快速编码 + 系统设计一体 |
`;

describe('F208 AC-E3: execute-apply endpoint', () => {
  let app;
  let tempDir;
  let store;

  before(async () => {
    // Create temp git repo with dossier file
    tempDir = mkdtempSync(join(tmpdir(), 'cat-cafe-e3-test-'));
    const docsDir = join(tempDir, 'docs', 'team');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'cat-dossier.md'), DOSSIER_CONTENT, 'utf8');

    // Init git repo
    execFileSync('git', ['init'], { cwd: tempDir });
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir });

    // Create a bare remote to test push
    const remoteDir = tempDir + '-remote.git';
    execFileSync('git', ['clone', '--bare', tempDir, remoteDir]);
    execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: tempDir });

    // Import and build app
    const { InMemoryDossierDistillationProposalStore } = await import(
      '../dist/domains/cats/services/stores/ports/DossierDistillationProposalStore.js'
    );
    const { distillationRoutes } = await import('../dist/routes/dossier-distillations.js');
    const Fastify = (await import('fastify')).default;

    store = new InMemoryDossierDistillationProposalStore();
    app = Fastify();

    await app.register(distillationRoutes, {
      distillationStore: store,
      repoRoot: tempDir,
    });
    await app.ready();
  });

  after(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(tempDir + '-remote.git', { recursive: true, force: true });
    }
  });

  function createApprovedProposal(overrides = {}) {
    return store.create({
      sourceEvent: 'feat-phase-close',
      sourceId: `feat-phase-close:F208:E:${Date.now()}`,
      targetCatId: 'opus',
      targetFields: ['nativePeakAbilities'],
      beforeSnapshot: '快速编码 + 系统设计一体',
      afterDraft: '快速编码 + 系统设计一体 + 事件驱动蒸馏设计',
      rationale: 'Phase E AC-E2 实现展示了 spec→impl→test 全链路能力',
      evidenceRefs: [{ type: 'review', id: 'PR#2467', summary: 'AC-E2 PR' }],
      baseHash: hash(DOSSIER_CONTENT),
      createdBy: 'system',
      ...overrides,
    });
  }

  it('happy path: approved proposal → file written + git committed + marked applied', async () => {
    const proposal = createApprovedProposal();
    // Approve it
    store.markApproved(proposal.proposalId, 'you');

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposal.proposalId}/execute-apply`,
      headers: { 'x-cat-cafe-user': 'opus' },
    });

    assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.ok(body.commitSha, 'Must return commitSha');
    assert.equal(body.proposal.status, 'applied');
    assert.equal(body.proposal.appliedCommitSha, body.commitSha);

    // Verify file was actually modified on disk
    const fileContent = readFileSync(join(tempDir, 'docs/team/cat-dossier.md'), 'utf8');
    assert.ok(fileContent.includes('事件驱动蒸馏设计'), 'afterDraft content must be in file');

    // Verify git log
    const log = execFileSync('git', ['log', '--oneline', '-1'], { cwd: tempDir, encoding: 'utf8' });
    assert.ok(log.includes('F208'), 'Commit message must reference F208');
  });

  it('rejects with 401 when unauthenticated', async () => {
    const proposal = createApprovedProposal();
    store.markApproved(proposal.proposalId, 'you');

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposal.proposalId}/execute-apply`,
      // No x-cat-id header
    });

    assert.equal(res.statusCode, 401);
  });

  it('rejects with 403 when caller is not the target cat', async () => {
    const proposal = createApprovedProposal();
    store.markApproved(proposal.proposalId, 'you');

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposal.proposalId}/execute-apply`,
      headers: { 'x-cat-cafe-user': 'codex' }, // Not 'opus' (the target)
    });

    assert.equal(res.statusCode, 403);
  });

  it('rejects with 409 when proposal is not approved', async () => {
    const proposal = createApprovedProposal();
    // Don't approve — stays pending

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposal.proposalId}/execute-apply`,
      headers: { 'x-cat-cafe-user': 'opus' },
    });

    assert.equal(res.statusCode, 409);
  });

  it('rejects with 409 on baseHash mismatch (stale-write lock)', async () => {
    // Create proposal with wrong baseHash
    const proposal = createApprovedProposal({ baseHash: 'deadbeef'.repeat(8) });
    store.markApproved(proposal.proposalId, 'you');

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposal.proposalId}/execute-apply`,
      headers: { 'x-cat-cafe-user': 'opus' },
    });

    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'BASE_HASH_MISMATCH');
  });

  it('rejects with 404 for non-existent proposal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dossier/distillations/nonexistent/execute-apply',
      headers: { 'x-cat-cafe-user': 'opus' },
    });

    assert.equal(res.statusCode, 404);
  });

  it('P1-2: rolls back file on git commit failure and keeps proposal retryable', async () => {
    // Reset file to known state (previous tests may have modified it)
    const dossierPath = join(tempDir, 'docs/team/cat-dossier.md');
    writeFileSync(dossierPath, DOSSIER_CONTENT, 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'reset for rollback test', '--allow-empty-message'], { cwd: tempDir });

    const proposal = createApprovedProposal();
    store.markApproved(proposal.proposalId, 'you');

    // Sabotage git: corrupt index to make git add/commit fail
    const indexPath = join(tempDir, '.git', 'index');
    const originalIndex = readFileSync(indexPath);
    writeFileSync(indexPath, 'corrupted-index-data', 'utf8');

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposal.proposalId}/execute-apply`,
      headers: { 'x-cat-cafe-user': 'opus' },
    });

    // Restore git index for subsequent tests
    writeFileSync(indexPath, originalIndex);
    execFileSync('git', ['reset'], { cwd: tempDir });

    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'GIT_FAILURE');

    // CRITICAL: file must be ROLLED BACK to original content
    const fileAfter = readFileSync(dossierPath, 'utf8');
    assert.equal(fileAfter, DOSSIER_CONTENT, 'File must be rolled back on git failure');

    // Proposal must still be in 'approved' state (retryable)
    const stored = await store.get(proposal.proposalId);
    assert.equal(stored.status, 'approved', 'Proposal must remain approved for retry');
  });

  it('P1-new-2: rolls back file AND index when git add succeeds but commit fails (pre-commit hook)', async () => {
    // Regression: if git add succeeds, the index has modified content.
    // Old code used `git checkout --` which reads FROM INDEX, defeating the rollback.
    // Fix uses `git reset HEAD --` to unstage, keeping the writeFile-restored content.
    const dossierPath = join(tempDir, 'docs/team/cat-dossier.md');
    execFileSync('git', ['checkout', '--', '.'], { cwd: tempDir });
    writeFileSync(dossierPath, DOSSIER_CONTENT, 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    try {
      execFileSync('git', ['commit', '-m', 'reset for pre-commit hook test'], { cwd: tempDir });
    } catch {
      /* may be clean */
    }

    const proposal = createApprovedProposal();
    store.markApproved(proposal.proposalId, 'you');

    // Sabotage commit: install a pre-commit hook that always fails
    // This lets git add succeed but git commit fail
    const hookDir = join(tempDir, '.git', 'hooks');
    mkdirSync(hookDir, { recursive: true });
    const hookPath = join(hookDir, 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposal.proposalId}/execute-apply`,
      headers: { 'x-cat-cafe-user': 'opus' },
    });

    // Remove hook for subsequent tests
    rmSync(hookPath, { force: true });
    // Clean up any staged changes left by the failed attempt
    execFileSync('git', ['reset', 'HEAD', '--', '.'], { cwd: tempDir }).toString();

    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'GIT_FAILURE');

    // CRITICAL: file must be ROLLED BACK to original content (not the modified version from index)
    const fileAfter = readFileSync(dossierPath, 'utf8');
    assert.equal(fileAfter, DOSSIER_CONTENT, 'File must be rolled back even when git add succeeded');

    // Proposal must still be approved (retryable)
    const stored = await store.get(proposal.proposalId);
    assert.equal(stored.status, 'approved', 'Proposal must remain approved for retry');
  });

  it('P1-2: returns commitSha when commit succeeds but push fails', async () => {
    // Reset file to known state (checkout clean + write + commit)
    const dossierPath = join(tempDir, 'docs/team/cat-dossier.md');
    execFileSync('git', ['checkout', '--', '.'], { cwd: tempDir });
    writeFileSync(dossierPath, DOSSIER_CONTENT, 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    try {
      execFileSync('git', ['commit', '-m', 'reset for push-fail test'], { cwd: tempDir });
    } catch {
      /* may be clean */
    }

    const proposal = createApprovedProposal();
    store.markApproved(proposal.proposalId, 'you');

    // Sabotage push: point remote to non-existent path
    execFileSync('git', ['remote', 'set-url', 'origin', '/nonexistent/path.git'], { cwd: tempDir });

    const res = await app.inject({
      method: 'POST',
      url: `/api/dossier/distillations/${proposal.proposalId}/execute-apply`,
      headers: { 'x-cat-cafe-user': 'opus' },
    });

    // Restore remote for subsequent tests
    execFileSync('git', ['remote', 'set-url', 'origin', tempDir + '-remote.git'], { cwd: tempDir });

    // Should return partial success with commitSha (commit landed, push failed)
    const body = JSON.parse(res.body);
    assert.ok(body.commitSha, 'Must return commitSha even when push fails');
    assert.equal(body.code, 'PUSH_FAILURE');
    assert.equal(body.fileWritten, true);
    assert.equal(body.committed, true);

    // Proposal should be marked applied (commit is the truth source, not push)
    assert.equal(body.proposal.status, 'applied');
  });
});
