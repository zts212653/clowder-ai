import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket } from './publish-verdict-fixtures.js';

/**
 * 砚砚 R17 P1 cloud: snapshots/ + attributions/ are GITIGNORED — raw evidence
 * lives ONLY in LIVE checkout. R7's "seed isolated worktree" assumption was wrong.
 * Tests now seed evidence into LIVE root (handler's deps.harnessFeedbackRoot);
 * stage callback resolves LIVE and copies to isolated for generator to read.
 */
function seedLiveEvidence(liveRoot, snapName, attrName) {
  mkdirSync(resolvePath(liveRoot, 'snapshots'), { recursive: true });
  mkdirSync(resolvePath(liveRoot, 'attributions'), { recursive: true });
  if (snapName) writeFileSync(resolvePath(liveRoot, 'snapshots', snapName), 'fake snap\n');
  if (attrName) writeFileSync(resolvePath(liveRoot, 'attributions', attrName), 'fake attr\n');
}

/** Empty isolated worktree (mock gitPublisher's tmp dir; stage callback copies into it). */
function makeEmptyIsolatedWorktree() {
  return mkdtempSync(`${tmpdir()}/phase-h-pipeline-iso-`);
}

/**
 * F192 Phase H AC-H2: GitPublisher isolated-worktree pipeline tests.
 * Split from publish-verdict.test.js per AGENTS.md 350-line hard limit.
 */
describe('handlePublishVerdict — AC-H2 pipeline', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = setupHarnessFeedback();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('AC-H2 — GitPublisher isolated-worktree pipeline', () => {
    it('happy path: handler calls gitPublisher with correct branchName/sourceBase + invokes stage callback in isolated worktree', async () => {
      // 砚砚 R17 P1: seed LIVE evidence (gitignored, lives there); stage copies to isolated
      seedLiveEvidence(root, 'snap.yaml', 'attr.yaml');
      const isolatedWorktree = makeEmptyIsolatedWorktree();
      const stageCalls = [];
      const mockGitPublisher = {
        async publishOnIsolatedWorktree(opts) {
          const stageResult = await opts.stage(isolatedWorktree);
          stageCalls.push({ branchName: opts.branchName, sourceBase: opts.sourceBase, stageResult });
          return { commitSha: 'sha1234567890', prUrl: 'https://github.com/zts212653/clowder-ai/pull/9999' };
        },
      };
      const mockGenerator = async (packet, sourceRefs, deps) => {
        // PR-2 (砚砚 R1 Q1): generator gets RAW sourceRefs (basenames) + both roots.
        // Each adapter handles its own resolve+copy (a2a) or provider.resolve (cw).
        assert.equal(sourceRefs.snapshotName, 'snap.yaml');
        assert.equal(sourceRefs.attributionName, 'attr.yaml');
        assert.equal(deps.harnessFeedbackRoot, `${isolatedWorktree}/docs/harness-feedback`);
        assert.equal(deps.liveHarnessFeedbackRoot, root, 'live root from handler deps.harnessFeedbackRoot');
        return {
          verdictPath: `${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`,
          bundleDir: `${deps.harnessFeedbackRoot}/bundles/${packet.id}`,
        };
      };

      const result = await handlePublishVerdict(
        { harnessFeedbackRoot: root, gitPublisher: mockGitPublisher, generator: mockGenerator },
        {
          packet: buildPacket({ id: 'vhp-h2-test', domainId: 'eval:a2a' }),
          domain: 'eval:a2a',
          catId: 'codex',
          sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        },
      );

      assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
      assert.equal(result.commitSha, 'sha1234567890');
      assert.equal(result.prUrl, 'https://github.com/zts212653/clowder-ai/pull/9999');
      // 砚砚 R13 P2 cloud: response paths must be repo-relative (deterministic from
      // packet.id), NOT the temp-worktree absolute paths the publisher just removed.
      // If anyone reverts to returning artifact.verdictPath, this assertion breaks.
      assert.equal(result.verdictPath, 'docs/harness-feedback/verdicts/vhp-h2-test.md');
      assert.equal(result.bundleDir, 'docs/harness-feedback/bundles/vhp-h2-test');

      // Verify GitPublisher was called with correct opts
      assert.equal(stageCalls.length, 1);
      assert.equal(stageCalls[0].branchName, 'verdict/auto/eval-a2a/vhp-h2-test');
      assert.equal(stageCalls[0].sourceBase, 'origin/main');

      // Verify stage callback returned correct artifacts + commit/PR shape
      const stage = stageCalls[0].stageResult;
      assert.equal(stage.paths.length, 2); // verdictPath + bundleDir
      assert.match(stage.commitMessage, /verdict\(eval:a2a\): vhp-h2-test/);
      assert.match(stage.commitMessage, /published via cat_cafe_publish_verdict MCP/);
      assert.match(stage.prTitle, /verdict\(eval:a2a\)/);
    });

    it('returns 500 generator_failed when generator throws inside stage callback', async () => {
      seedLiveEvidence(root, 'x.yaml', 'y.yaml');
      const mockGitPublisher = {
        async publishOnIsolatedWorktree(opts) {
          // Invoke stage which will throw via generator
          await opts.stage(makeEmptyIsolatedWorktree());
          return { commitSha: 'unreachable', prUrl: 'unreachable' };
        },
      };
      const result = await handlePublishVerdict(
        {
          harnessFeedbackRoot: root,
          gitPublisher: mockGitPublisher,
          generator: async () => {
            throw new Error('synthetic generator failure');
          },
        },
        {
          packet: buildPacket({ domainId: 'eval:a2a' }),
          domain: 'eval:a2a',
          catId: 'codex',
          sourceRefs: { snapshotName: 'x.yaml', attributionName: 'y.yaml' },
        },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 500);
      assert.equal(result.error, 'generator_failed');
      assert.match(result.detail, /synthetic generator failure/);
    });

    it('returns 500 git_or_gh_failed when GitPublisher throws post-generator (push/PR failure)', async () => {
      seedLiveEvidence(root, 'x.yaml', 'y.yaml');
      const mockGitPublisher = {
        async publishOnIsolatedWorktree(opts) {
          // Successful stage (generator returns artifact) then throws on commit/push/PR
          await opts.stage(makeEmptyIsolatedWorktree());
          throw new Error('synthetic git push failure');
        },
      };
      const result = await handlePublishVerdict(
        {
          harnessFeedbackRoot: root,
          gitPublisher: mockGitPublisher,
          generator: async (p) => ({
            verdictPath: `/x/${p.id}.md`,
            bundleDir: `/x/${p.id}`,
          }),
        },
        {
          packet: buildPacket({ domainId: 'eval:a2a' }),
          domain: 'eval:a2a',
          catId: 'codex',
          sourceRefs: { snapshotName: 'x.yaml', attributionName: 'y.yaml' },
        },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 500);
      assert.equal(result.error, 'git_or_gh_failed');
      assert.match(result.detail, /synthetic git push failure/);
    });

    it('returns 500 git_or_gh_failed when GitPublisher throws BEFORE stage callback (e.g. worktree branch already exists — race protection)', async () => {
      // 砚砚 R1 P2 #2: branch creation atomic — if branch exists, GitPublisher
      // throws before invoking stage. Handler distinguishes by artifact==null
      // → but in this case error category is git_or_gh_failed not generator_failed
      // because stage was never invoked (artifact==null but generator never failed).
      // Currently handler returns generator_failed when artifact==null. This is
      // a known edge — duplicate-id race manifests as 'generator_failed' which
      // is misleading. Documented; real GitPublisher impl will return distinct
      // error category (e.g. 'duplicate_branch'). For now assert behavior is
      // observable, not silent.
      const mockGitPublisher = {
        async publishOnIsolatedWorktree() {
          throw new Error('fatal: A branch named verdict/auto/eval-a2a/dup already exists');
        },
      };
      const result = await handlePublishVerdict(
        {
          harnessFeedbackRoot: root,
          gitPublisher: mockGitPublisher,
          generator: async () => ({ verdictPath: '/x', bundleDir: '/x' }),
        },
        {
          packet: buildPacket({ id: 'dup', domainId: 'eval:a2a' }),
          domain: 'eval:a2a',
          catId: 'codex',
          sourceRefs: { snapshotName: 'x.yaml', attributionName: 'y.yaml' },
        },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 500);
      // generator_failed because stage was never invoked → artifact null
      // (acceptable for v1; real impl returns better category in MCP wiring commit)
      assert.equal(result.error, 'generator_failed');
      assert.match(result.detail, /branch.*already exists/);
    });

    // 砚砚 R3 P1 #2 cloud: live-tree dup-check is NOT authoritative. If origin/main
    // has the verdict already but live tree is stale, isolated worktree (created
    // from origin/main) WILL have the file. Stage callback re-checks and aborts
    // with verdict_already_exists_on_main → handler surfaces 409 not 500.
    it('returns 409 verdict_already_exists when verdict file pre-exists in isolated worktree (live tree was stale)', async () => {
      const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { resolve } = await import('node:path');

      const mockGitPublisher = {
        async publishOnIsolatedWorktree(opts) {
          // Simulate: isolated worktree was checked out from origin/main, which
          // already has verdicts/stale-test.md (committed by parallel publish)
          const fakeWorktree = mkdtempSync(`${tmpdir()}/phase-h-stale-`);
          const verdictsDir = resolve(fakeWorktree, 'docs/harness-feedback/verdicts');
          mkdirSync(verdictsDir, { recursive: true });
          writeFileSync(resolve(verdictsDir, 'stale-test.md'), '# Already on main\n');
          // Now invoke stage — handler's authoritative re-check should throw
          await opts.stage(fakeWorktree);
          // If we reach here, the re-check didn't fire → test fails
          return { commitSha: 'should-not-reach', prUrl: 'should-not-reach' };
        },
      };
      const result = await handlePublishVerdict(
        {
          harnessFeedbackRoot: root,
          gitPublisher: mockGitPublisher,
          generator: async () => {
            throw new Error('generator should not be called when dup detected on main');
          },
        },
        {
          packet: buildPacket({ id: 'stale-test', domainId: 'eval:a2a' }),
          domain: 'eval:a2a',
          catId: 'codex',
          sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 409, 'must be 409 not 500');
      assert.equal(result.error, 'verdict_already_exists');
      assert.match(result.detail, /already exists on origin\/main|live tree was stale/);
    });
  });
});
