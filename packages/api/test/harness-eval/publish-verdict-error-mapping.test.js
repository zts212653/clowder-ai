import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { mapPublishVerdictError } from '../../dist/infrastructure/harness-eval/publish-verdict/error-mapping.js';
import { runVerdictPublishContract } from '../../dist/infrastructure/harness-eval/publish-verdict/publication/verdict-publish-contract-runner.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket, seedCanonicalMeasurementCensusState } from './publish-verdict-fixtures.js';

/**
 * F192 publish-verdict error-mapping — late collision classification.
 *
 * Prerequisite: when assertWindowsUnpublished detects a window collision
 * post-commit, the error must map to 409 (not fall through to 500
 * git_or_gh_failed). Without this classification, callers cannot distinguish
 * true collisions (409) from infrastructure failures (500). Follow-up will
 * add a typed success path for expected replays (no_new_window).
 */
describe('mapPublishVerdictError', () => {
  it('maps verdict_window_already_published to 409', () => {
    const result = mapPublishVerdictError(
      'verdict_window_already_published: 2026-09-06-design-gate-keep-observe conflicts with existing verdict 2026-08-30-design-gate-keep-observe',
    );
    assert.ok(result, 'must not return null — null falls through to 500 git_or_gh_failed');
    assert.equal(result.status, 409);
    assert.equal(result.error, 'verdict_window_already_published');
    assert.match(result.detail, /conflicts with existing verdict/);
  });

  it('maps verdict_window_duplicated_in_candidate to 409', () => {
    const result = mapPublishVerdictError(
      'verdict_window_duplicated_in_candidate: id-b duplicates id-a for the same domain/window',
    );
    assert.ok(result, 'must not return null');
    assert.equal(result.status, 409);
    assert.equal(result.error, 'verdict_window_duplicated_in_candidate');
    assert.match(result.detail, /same domain\/window/);
  });

  it('maps verdict_already_exists_on_main to 409', () => {
    const result = mapPublishVerdictError(
      "verdict_already_exists_on_main: packet.id 'foo' already exists on origin/main.",
    );
    assert.ok(result);
    assert.equal(result.status, 409);
    assert.equal(result.error, 'verdict_already_exists');
  });

  it('returns null for unknown error prefixes (fallthrough to 500)', () => {
    assert.equal(mapPublishVerdictError('some_unknown_error: details'), null);
  });

  it('maps all existing error prefixes (completeness guard)', () => {
    const knownPrefixes = [
      'invalid_analysis_findings',
      'measurement_validity_gate',
      'verdict_already_exists_on_main',
      'verdict_window_already_published',
      'verdict_window_duplicated_in_candidate',
      'invalid_source_ref',
      'evidence_not_found',
      'session_not_found',
      'owner_user_required',
      'no_trials_in_window',
      'no_metrics_in_window',
      'invalid_packet_field',
      'invalid_episode_verdict_writeback',
      'handoff_incomplete',
    ];
    for (const prefix of knownPrefixes) {
      const result = mapPublishVerdictError(`${prefix}: test detail`);
      assert.ok(result, `${prefix} must be mapped (got null → would fall through to 500)`);
      assert.ok(typeof result.status === 'number', `${prefix} must have a status code`);
      assert.ok(typeof result.error === 'string', `${prefix} must have an error code`);
    }
  });
});

/**
 * F192 integration: verdict_window_already_published thrown by contract runner
 * INSIDE publishOnIsolatedWorktree (post-commit) must map to 409 via error-mapping,
 * not fall through to 500 git_or_gh_failed.
 *
 * This validates the late collision classification prerequisite: the pipeline
 * catch block correctly routes window collisions to 409. The follow-up typed
 * success path (expected replay → no_new_window, side effects=0) depends on
 * this classification being in place first.
 */
describe('handlePublishVerdict — verdict_window_already_published pipeline path', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = setupHarnessFeedback();
    // Seed live evidence so the generator doesn't fail before reaching the contract
    mkdirSync(resolve(root, 'snapshots'), { recursive: true });
    mkdirSync(resolve(root, 'attributions'), { recursive: true });
    writeFileSync(resolve(root, 'snapshots', 'snap.yaml'), 'fake snap\n');
    writeFileSync(resolve(root, 'attributions', 'attr.yaml'), 'fake attr\n');
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns 409 verdict_window_already_published when contract runner detects window collision (not 500)', async () => {
    let contractCallCount = 0;
    const mockGitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        const fakeWorktree = mkdtempSync(`${tmpdir()}/phase-h-window-`);
        seedCanonicalMeasurementCensusState(fakeWorktree);
        await opts.stage(fakeWorktree);
        // After stage+commit, contract runner detects window collision.
        // This simulates assertWindowsUnpublished throwing inside the
        // real contractRunner at git-worktree-publisher.ts:215-222.
        contractCallCount += 1;
        throw new Error(
          'verdict_window_already_published: 2026-09-13-design-gate-keep-observe conflicts with existing verdict 2026-09-06-design-gate-keep-observe',
        );
      },
    };

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        gitPublisher: mockGitPublisher,
        generator: async (packet, _sourceRefs, deps) => {
          const bundleDir = `${deps.harnessFeedbackRoot}/bundles/${packet.id}`;
          mkdirSync(bundleDir, { recursive: true });
          const verdictPath = `${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`;
          writeFileSync(verdictPath, `---\ndomain_id: ${packet.domainId}\n---\n`);
          return { verdictPath, bundleDir };
        },
      },
      {
        packet: buildPacket({ id: 'window-dup-test', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );

    assert.ok('error' in result, 'must return an error result');
    assert.equal(result.status, 409, 'must be 409 (conflict), not 500 (git_or_gh_failed)');
    assert.equal(result.error, 'verdict_window_already_published');
    assert.match(result.detail, /conflicts with existing verdict/);
    assert.equal(contractCallCount, 1, 'contract runner must have been reached');
  });
});

/**
 * Regression: runVerdictPublishContract calls check-verdict-publish-contract.mjs
 * via promisify(execFile). On non-zero exit, Node wraps the error as:
 *   "Command failed: <command>\n<stderr>"
 * If the runner does not normalize stderr, mapPublishVerdictError's startsWith
 * checks never match and the handler falls through to 500 git_or_gh_failed.
 *
 * These tests exercise the real execFile error shape through the runner to prove
 * the domain error code survives transport and reaches the mapper intact.
 */
describe('runVerdictPublishContract — execFile error normalization', () => {
  /** @type {string} */
  let fakeRepoRoot;

  before(() => {
    fakeRepoRoot = mkdtempSync(`${tmpdir()}/contract-runner-norm-`);
    mkdirSync(resolve(fakeRepoRoot, 'scripts'), { recursive: true });
  });

  after(() => {
    rmSync(fakeRepoRoot, { recursive: true, force: true });
  });

  /**
   * Helper: create a fake contract script that writes a structured error to
   * stderr and exits 1, exactly like the real check-verdict-publish-contract.mjs
   * does when assertWindowsUnpublished throws.
   */
  function seedFailingContractScript(errorCode) {
    const scriptPath = resolve(fakeRepoRoot, 'scripts/check-verdict-publish-contract.mjs');
    writeFileSync(scriptPath, `process.stderr.write('${errorCode}: test detail\\n');\nprocess.exitCode = 1;\n`);
    chmodSync(scriptPath, 0o755);
  }

  it('normalizes verdict_window_already_published from execFile wrapper', async () => {
    seedFailingContractScript('verdict_window_already_published');
    try {
      await runVerdictPublishContract({
        repoRoot: fakeRepoRoot,
        implementationRoot: fakeRepoRoot,
        expectedRepoFullName: 'test/repo',
        remoteName: 'origin',
        baseRef: 'origin/main',
        sourceRef: 'HEAD',
        identityOnly: true,
      });
      assert.fail('must throw');
    } catch (err) {
      // The error message must start with the domain code, not "Command failed:"
      assert.ok(
        err.message.startsWith('verdict_window_already_published'),
        `expected message to start with domain code, got: ${err.message.slice(0, 80)}`,
      );
      // Must be mappable to 409
      const mapped = mapPublishVerdictError(err.message);
      assert.ok(mapped, 'normalized error must be mappable (not null)');
      assert.equal(mapped.status, 409);
      assert.equal(mapped.error, 'verdict_window_already_published');
    }
  });

  it('normalizes verdict_window_duplicated_in_candidate from execFile wrapper', async () => {
    seedFailingContractScript('verdict_window_duplicated_in_candidate');
    try {
      await runVerdictPublishContract({
        repoRoot: fakeRepoRoot,
        implementationRoot: fakeRepoRoot,
        expectedRepoFullName: 'test/repo',
        remoteName: 'origin',
        baseRef: 'origin/main',
        sourceRef: 'HEAD',
        identityOnly: true,
      });
      assert.fail('must throw');
    } catch (err) {
      assert.ok(
        err.message.startsWith('verdict_window_duplicated_in_candidate'),
        `expected message to start with domain code, got: ${err.message.slice(0, 80)}`,
      );
      const mapped = mapPublishVerdictError(err.message);
      assert.ok(mapped, 'normalized error must be mappable (not null)');
      assert.equal(mapped.status, 409);
      assert.equal(mapped.error, 'verdict_window_duplicated_in_candidate');
    }
  });
});
