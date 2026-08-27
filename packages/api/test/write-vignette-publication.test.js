// @ts-check
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SessionMutex } from '../dist/domains/cats/services/agents/invocation/SessionMutex.js';
import { approveTasteProposal } from '../dist/domains/taste/services/approveTasteProposal.js';
import { createVignetteWriter, deriveSlug } from '../dist/domains/taste/services/writeVignette.js';
import { InMemoryTasteProposalStore } from '../dist/domains/taste/stores/InMemoryTasteProposalStore.js';
import { anchorApproval } from './approval-hub/helpers.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function configureIdentity(cwd) {
  git(cwd, ['config', 'user.email', 'test@cat-cafe.local']);
  git(cwd, ['config', 'user.name', 'Taste Publication Test']);
}

function makeProposal(overrides = {}) {
  return {
    id: 'proposal_publication_abc123',
    userId: 'user-1',
    catId: 'codex-sol',
    threadId: 'thread-1',
    scene: 'operator approved a reusable editing judgment',
    quote: '节奏要服务叙事，不要只是堆转场',
    tags: ['视频剪辑', '叙事节奏'],
    dimension: 'creative-craft',
    privacy: 'public',
    status: 'approving',
    createdAt: 1787620000000,
    ...overrides,
  };
}

function createRemoteFixture() {
  const root = mkdtempSync(join(tmpdir(), 'f221-publication-'));
  const origin = join(root, 'origin.git');
  const primary = join(root, 'primary');
  const runtime = join(root, 'runtime');
  const hookLog = join(root, 'pre-push.log');
  git(root, ['init', '--bare', '--initial-branch=main', origin]);
  git(root, ['clone', origin, primary]);
  configureIdentity(primary);
  mkdirSync(join(primary, 'docs/taste'), { recursive: true });
  writeFileSync(join(primary, 'README.md'), 'fixture\n');
  writeFileSync(join(primary, 'docs/taste/index.md'), '# Taste Index\n\n### 创作手法\n', 'utf8');
  git(primary, ['add', 'README.md', 'docs/taste/index.md']);
  git(primary, ['commit', '-m', 'seed taste repository']);
  git(primary, ['push', '-u', 'origin', 'main']);
  const hooksDir = join(primary, '.githooks');
  mkdirSync(hooksDir);
  writeFileSync(join(hooksDir, 'pre-push'), `#!/bin/sh\nprintf 'called\\n' >> '${hookLog}'\n`);
  chmodSync(join(hooksDir, 'pre-push'), 0o755);
  git(primary, ['config', 'core.hooksPath', hooksDir]);
  git(primary, ['worktree', 'add', '-b', 'runtime/main-sync', runtime]);
  return { root, origin, primary, runtime, hookLog };
}

function advanceRemote(fixture, filename = 'remote-only.md') {
  const remoteWriter = join(fixture.root, `remote-writer-${Date.now()}-${Math.random()}`);
  git(fixture.root, ['clone', fixture.origin, remoteWriter]);
  configureIdentity(remoteWriter);
  writeFileSync(join(remoteWriter, filename), `${filename}\n`);
  git(remoteWriter, ['add', filename]);
  git(remoteWriter, ['commit', '-m', `advance remote with ${filename}`]);
  git(remoteWriter, ['push', 'origin', 'main']);
  return git(remoteWriter, ['rev-parse', 'HEAD']);
}

function divergeAndStagePrimary(fixture) {
  writeFileSync(join(fixture.primary, 'local-only.md'), 'local ahead commit\n');
  git(fixture.primary, ['add', 'local-only.md']);
  git(fixture.primary, ['commit', '-m', 'local operator commit']);
  advanceRemote(fixture);
  writeFileSync(join(fixture.primary, 'concurrent-wip.md'), 'staged human work\n');
  git(fixture.primary, ['add', 'concurrent-wip.md']);
}

function remoteFile(fixture, path) {
  return git(fixture.root, ['--git-dir', fixture.origin, 'show', `main:${path}`]);
}

function remoteHead(fixture) {
  return git(fixture.root, ['--git-dir', fixture.origin, 'rev-parse', 'main']);
}

async function createStoredProposal(store) {
  const proposal = store.create({
    userId: 'user-1',
    catId: 'codex-sol',
    threadId: 'thread-1',
    scene: 'operator approved a reusable editing judgment',
    quote: '节奏要服务叙事，不要只是堆转场',
    tags: ['视频剪辑'],
    dimension: 'creative-craft',
    privacy: 'public',
  });
  await anchorApproval(store, {
    proposalId: proposal.id,
    sourceFeatureId: 'F221',
    ownerUserId: proposal.userId,
    requesterCatId: proposal.catId,
    threadId: proposal.threadId,
    createdAt: proposal.createdAt,
  });
  return proposal;
}

describe('F221 public Taste publication terminal', () => {
  let fixture;

  beforeEach(() => {
    fixture = createRemoteFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('publishes from an isolated checkout without mutating a dirty, diverged primary main', async () => {
    divergeAndStagePrimary(fixture);
    const proposal = makeProposal();
    const slug = deriveSlug(proposal);
    const primaryHeadBefore = git(fixture.primary, ['rev-parse', 'HEAD']);
    const primaryStatusBefore = git(fixture.primary, ['status', '--porcelain=v1']);

    const result = await createVignetteWriter(fixture.runtime)(proposal);

    assert.equal(result.path, `docs/taste/vignettes/${slug}.md`);
    assert.equal(git(fixture.primary, ['rev-parse', 'HEAD']), primaryHeadBefore);
    assert.equal(git(fixture.primary, ['status', '--porcelain=v1']), primaryStatusBefore);
    assert.match(remoteFile(fixture, result.path), /proposalId: proposal_publication_abc123/);
    assert.match(remoteFile(fixture, 'docs/taste/index.md'), new RegExp(`vignettes/${slug}\\.md`));
    assert.equal(readFileSync(fixture.hookLog, 'utf8'), 'called\n');
    assert.equal(readFileSync(join(fixture.primary, 'concurrent-wip.md'), 'utf8'), 'staged human work\n');
  });

  it('does not settle approved when origin rejects the publication push', async () => {
    const hook = join(fixture.origin, 'hooks/pre-receive');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    const store = new InMemoryTasteProposalStore();
    const proposal = await createStoredProposal(store);
    const baseRemoteHead = remoteHead(fixture);

    const result = await approveTasteProposal(proposal.id, 'user-1', {
      store,
      lock: new SessionMutex(),
      lockKey: () => 'taste-publication-test',
      writeVignette: createVignetteWriter(fixture.runtime),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'write_failed');
    assert.equal(store.get(proposal.id).status, 'pending');
    assert.equal(remoteHead(fixture), baseRemoteHead);
  });

  it('keeps an indeterminate final push approving and later finalizes the published projection once', async () => {
    const store = new InMemoryTasteProposalStore();
    const proposal = await createStoredProposal(store);
    const baseCount = Number(git(fixture.root, ['--git-dir', fixture.origin, 'rev-list', '--count', 'main']));
    const writer = createVignetteWriter(fixture.runtime, {
      beforePush: ({ attempt }) => {
        if (attempt < 3) {
          advanceRemote(fixture, `race-${attempt}.md`);
          return;
        }
        const hook = join(fixture.primary, '.githooks/pre-push');
        writeFileSync(
          hook,
          `#!/bin/sh\ngit -c core.hooksPath=/dev/null push origin HEAD:refs/heads/main\ngit remote set-url origin '${join(fixture.root, 'missing-origin.git')}'\nexit 1\n`,
        );
        chmodSync(hook, 0o755);
      },
    });
    const deps = {
      store,
      lock: new SessionMutex(),
      lockKey: () => 'taste-publication-indeterminate-test',
      writeVignette: writer,
    };

    const first = await approveTasteProposal(proposal.id, 'user-1', deps);
    const remoteAfterFirst = remoteHead(fixture);
    const retried = await approveTasteProposal(proposal.id, 'user-1', deps);

    assert.equal(first.ok, false);
    assert.equal(first.reason, 'write_failed');
    assert.equal(first.proposal?.status, 'approving');
    assert.equal(retried.ok, true);
    assert.equal(retried.recovered, true);
    assert.equal(store.get(proposal.id).status, 'approved');
    assert.equal(remoteHead(fixture), remoteAfterFirst);
    assert.equal(
      Number(git(fixture.root, ['--git-dir', fixture.origin, 'rev-list', '--count', 'main'])),
      baseCount + 3,
    );
  });

  it('keeps a timed-out push approving until delayed remote completion can be reconciled', async () => {
    const hook = join(fixture.primary, '.githooks/pre-push');
    writeFileSync(hook, '#!/bin/sh\nsleep 1\n');
    chmodSync(hook, 0o755);
    const store = new InMemoryTasteProposalStore();
    const proposal = await createStoredProposal(store);
    const baseCount = Number(git(fixture.root, ['--git-dir', fixture.origin, 'rev-list', '--count', 'main']));
    const deps = {
      store,
      lock: new SessionMutex(),
      lockKey: () => 'taste-publication-timeout-test',
      writeVignette: createVignetteWriter(fixture.runtime, {
        gitCommandTimeoutMs: 100,
        beforePush: ({ checkoutRoot, baseSha, commitSha }) => {
          git(checkoutRoot, [
            '-c',
            'core.hooksPath=/dev/null',
            'push',
            'origin',
            `${commitSha}:refs/heads/delayed-timeout`,
          ]);
          setTimeout(() => {
            git(fixture.root, ['--git-dir', fixture.origin, 'update-ref', 'refs/heads/main', commitSha, baseSha]);
            git(fixture.root, ['--git-dir', fixture.origin, 'update-ref', '-d', 'refs/heads/delayed-timeout']);
          }, 500);
        },
      }),
    };

    const first = await approveTasteProposal(proposal.id, 'user-1', deps);

    assert.equal(first.ok, false);
    assert.equal(first.reason, 'write_failed');
    assert.equal(first.proposal?.status, 'approving');
    assert.equal(store.get(proposal.id).status, 'approving');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const remoteAfterCompletion = remoteHead(fixture);

    const retried = await approveTasteProposal(proposal.id, 'user-1', deps);

    assert.equal(retried.ok, true);
    assert.equal(retried.recovered, true);
    assert.equal(store.get(proposal.id).status, 'approved');
    assert.equal(remoteHead(fixture), remoteAfterCompletion);
    assert.equal(
      Number(git(fixture.root, ['--git-dir', fixture.origin, 'rev-list', '--count', 'main'])),
      baseCount + 1,
    );
  });

  it('publishes two consecutive proposals without losing either remote projection', async () => {
    divergeAndStagePrimary(fixture);
    const primaryHeadBefore = git(fixture.primary, ['rev-parse', 'HEAD']);
    const writer = createVignetteWriter(fixture.runtime);
    const first = makeProposal({ id: 'proposal_first_abc111', tags: ['第一条'] });
    const second = makeProposal({ id: 'proposal_second_abc222', tags: ['第二条'] });

    const firstResult = await writer(first);
    const secondResult = await writer(second);

    assert.match(remoteFile(fixture, firstResult.path), /proposalId: proposal_first_abc111/);
    assert.match(remoteFile(fixture, secondResult.path), /proposalId: proposal_second_abc222/);
    const index = remoteFile(fixture, 'docs/taste/index.md');
    assert.match(index, new RegExp(`vignettes/${deriveSlug(first)}\\.md`));
    assert.match(index, new RegExp(`vignettes/${deriveSlug(second)}\\.md`));
    assert.equal(git(fixture.primary, ['rev-parse', 'HEAD']), primaryHeadBefore);
  });

  it('recovers crash-after-push before checkpoint without creating another remote commit', async () => {
    class CheckpointFailingStore extends InMemoryTasteProposalStore {
      failuresRemaining = 1;
      recordWriteCheckpoint(id, checkpoint) {
        if (this.failuresRemaining-- > 0) throw new Error('redis unavailable after remote push');
        return super.recordWriteCheckpoint(id, checkpoint);
      }
    }
    const store = new CheckpointFailingStore();
    const proposal = await createStoredProposal(store);
    const deps = {
      store,
      lock: new SessionMutex(),
      lockKey: () => 'taste-publication-test',
      writeVignette: createVignetteWriter(fixture.runtime),
    };
    const baseCount = Number(git(fixture.root, ['--git-dir', fixture.origin, 'rev-list', '--count', 'main']));

    const first = await approveTasteProposal(proposal.id, 'user-1', deps);
    const retried = await approveTasteProposal(proposal.id, 'user-1', deps);

    assert.equal(first.ok, false);
    assert.equal(retried.ok, true);
    assert.equal(retried.recovered, true);
    assert.equal(store.get(proposal.id).status, 'approved');
    assert.equal(
      Number(git(fixture.root, ['--git-dir', fixture.origin, 'rev-list', '--count', 'main'])),
      baseCount + 1,
    );
  });

  it('rebases the projection on a verified remote race instead of overwriting the winner', async () => {
    let raced = false;
    const proposal = makeProposal({ id: 'proposal_race_abc333', tags: ['竞争重试'] });
    const writer = createVignetteWriter(fixture.runtime, {
      beforePush: () => {
        if (raced) return;
        raced = true;
        advanceRemote(fixture, 'race-winner.md');
      },
    });

    const result = await writer(proposal);

    assert.equal(raced, true);
    assert.equal(remoteFile(fixture, 'race-winner.md'), 'race-winner.md');
    assert.match(remoteFile(fixture, result.path), /proposalId: proposal_race_abc333/);
  });

  it('does not block the API event loop while a remote hook is running', async () => {
    writeFileSync(
      join(fixture.primary, '.githooks/pre-push'),
      `#!/bin/sh\nsleep 1\nprintf 'called\\n' >> '${fixture.hookLog}'\n`,
    );
    chmodSync(join(fixture.primary, '.githooks/pre-push'), 0o755);
    let publicationFinished = false;

    const publication = createVignetteWriter(fixture.runtime)(
      makeProposal({ id: 'proposal_nonblocking_abc444', tags: ['非阻塞'] }),
    ).then(() => {
      publicationFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(publicationFinished, false, 'slow remote publication must not freeze the API event loop');
    await publication;
  });
});
