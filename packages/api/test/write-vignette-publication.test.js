// @ts-check
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, test } from 'node:test';
import { SessionMutex } from '../dist/domains/cats/services/agents/invocation/SessionMutex.js';
import { approveTasteProposal } from '../dist/domains/taste/services/approveTasteProposal.js';
import { createVignetteWriter, deriveSlug } from '../dist/domains/taste/services/writeVignette.js';
import { InMemoryTasteProposalStore } from '../dist/domains/taste/stores/InMemoryTasteProposalStore.js';
import {
  advanceRemote,
  createRemoteFixture,
  createStoredProposal,
  divergeAndStagePrimary,
  git,
  makeProposal,
  remoteFile,
  remoteHead,
} from './taste-publication-fixtures.js';

describe('F221 public Taste publication terminal', () => {
  let fixture;
  /** Track timers scheduled by tests so afterEach can clear leaked ones. */
  const pendingTimers = [];

  beforeEach(() => {
    fixture = createRemoteFixture();
  });

  afterEach(() => {
    for (const t of pendingTimers) clearTimeout(t);
    pendingTimers.length = 0;
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
          pendingTimers.push(
            setTimeout(() => {
              git(fixture.root, ['--git-dir', fixture.origin, 'update-ref', 'refs/heads/main', commitSha, baseSha]);
              git(fixture.root, ['--git-dir', fixture.origin, 'update-ref', '-d', 'refs/heads/delayed-timeout']);
            }, 500),
          );
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

/**
 * Regression test: process-group-aware git() must kill hook children on timeout.
 *
 * Proves that after git() times out, no orphan hook child can continue
 * writing. Without process-group cleanup (detached + kill -PGID), the
 * hook child survives the parent timeout and writes a marker file. With
 * it, the entire group is reaped and the marker never appears.
 */
test('fixture git() kills hook children on timeout — no orphan writes after teardown', async () => {
  const fixture = createRemoteFixture();
  const orphanMarker = join(fixture.root, 'orphan-hook-wrote');

  try {
    // Install a pre-push hook that sleeps then writes a marker file.
    // If the hook child survives timeout, the marker appears.
    const hookScript = ['#!/bin/sh', `sleep 1 && printf "orphan" > '${orphanMarker}'`].join('\n');
    writeFileSync(join(fixture.primary, '.githooks/pre-push'), hookScript);
    chmodSync(join(fixture.primary, '.githooks/pre-push'), 0o755);

    // Stage a commit to push
    writeFileSync(join(fixture.primary, 'regression.md'), 'regression\n');
    git(fixture.primary, ['add', 'regression.md']);
    git(fixture.primary, ['commit', '-m', 'regression commit']);

    // Push with a short timeout — the hook sleeps 1s, so 200ms times out
    // before the hook can write the marker.
    assert.throws(() => git(fixture.primary, ['push', 'origin', 'main'], { timeout: 200 }), /ETIMEDOUT|timed out/i);

    // Wait long enough for the hook child to have written if it survived.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    assert.equal(
      existsSync(orphanMarker),
      false,
      'hook child must be killed by process-group cleanup — marker file should not exist',
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
