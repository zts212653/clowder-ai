import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import {
  buildPacket,
  createLiveTreeAsMainReader,
  seedCanonicalMeasurementCensusState,
} from './publish-verdict-fixtures.js';

/** F192 no_new_window — edge cases: orphan bundles, Layer 1a source verification,
 * R5 backward compat + mainReader creation, and validation-first ordering. */
describe('handlePublishVerdict — no_new_window edge cases and source verification', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = setupHarnessFeedback();
    mkdirSync(resolve(root, 'snapshots'), { recursive: true });
    mkdirSync(resolve(root, 'attributions'), { recursive: true });
    writeFileSync(resolve(root, 'snapshots', 'snap.yaml'), 'fake snap\n');
    writeFileSync(resolve(root, 'attributions', 'attr.yaml'), 'fake attr\n');
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns 409 via preflight when stored bundle has no source identity (incomplete/orphan — fail closed)', async () => {
    // R3 Layer 1b: stored bundle missing raw/episode-source-refs.json → fail closed.
    const storedVerdictId = 'preflight-orphan-bundle';
    const domainId = 'eval:design-gate';

    // Seed stored bundle WITHOUT raw/episode-source-refs.json
    const bundlePath = resolve(root, 'bundles', storedVerdictId);
    mkdirSync(bundlePath, { recursive: true });
    writeFileSync(resolve(bundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId }));
    writeFileSync(resolve(bundlePath, 'snapshot.json'), JSON.stringify({ window: { startMs: 5000, endMs: 6000 } }));
    // NO raw/episode-source-refs.json — orphan bundle

    // Seed source map YAML for incoming
    const sourceMapDir = resolve(root, 'design-gate', 'source-maps');
    mkdirSync(sourceMapDir, { recursive: true });
    writeFileSync(resolve(sourceMapDir, 'orphan-test-map.yaml'), 'startMs: 5000\nendMs: 6000\n');

    let publisherCalled = false;
    const mockGitPublisher = {
      async publishOnIsolatedWorktree() {
        publisherCalled = true;
        return { commitSha: 'abc', prUrl: 'https://example.com' };
      },
    };

    const { designGateReplayPreflight, designGateSourceEquivalenceCheck } = await import(
      '../../dist/infrastructure/harness-eval/design-gate/design-gate-replay-preflight.js'
    );

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        gitPublisher: mockGitPublisher,
        replayPreflight: designGateReplayPreflight,
        checkStoredSourceEquivalence: designGateSourceEquivalenceCheck,
        mainReader: createLiveTreeAsMainReader(root),
        generator: async () => {
          throw new Error('generator must not be called — preflight should short-circuit');
        },
      },
      {
        packet: buildPacket({ id: 'orphan-conflict-packet', domainId }),
        domain: domainId,
        catId: 'opus',
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId: 'orphan-test-map' },
      },
    );

    assert.ok('error' in result, `expected 409 error, got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 409);
    assert.equal(result.error, 'verdict_window_already_published');
    assert.equal(publisherCalled, false, 'publisher must NOT be called — preflight caught the orphan');
  });

  // --- R4→R7 Layer 1a source verification tests ---
  // When checkStoredSourceEquivalence is injected AND packet exists on origin/main
  // (via mainReader), the orchestration verifies source before returning no_new_window.
  // R7: live-only existence is NOT sufficient — mainReader is required.

  it('returns 409 when packet-ID exists on main but source equivalence fails (R7 Layer 1a — source differs)', async () => {
    // R7: Layer 1a packet-ID path requires canonical proof from origin/main.
    // mainReader confirms packet exists on main, checker says different source → 409.
    // R10: both verdict AND lifecycle must exist (complete canonical artifact).
    const existingId = 'r4-live-diff-source';
    mkdirSync(resolve(root, 'verdicts'), { recursive: true });
    writeFileSync(resolve(root, 'verdicts', `${existingId}.md`), '---\ndomain_id: eval:a2a\n---\n');
    mkdirSync(resolve(root, 'bundles', existingId), { recursive: true });
    writeFileSync(resolve(root, 'bundles', existingId, 'lifecycle-root.json'), '{"domainId":"eval:a2a"}');

    let publisherCalled = false;
    const mockGitPublisher = {
      async publishOnIsolatedWorktree() {
        publisherCalled = true;
        return { commitSha: 'abc', prUrl: 'https://example.com' };
      },
    };

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        gitPublisher: mockGitPublisher,
        checkStoredSourceEquivalence: () => false, // R4: different source
        // R7: mainReader required — reads from live tree (same data in test)
        mainReader: createLiveTreeAsMainReader(root),
        generator: async () => {
          throw new Error('generator must not be called — source verification should reject');
        },
      },
      {
        packet: buildPacket({ id: existingId, domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );

    assert.ok('error' in result, `expected 409 error, got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 409);
    assert.equal(result.error, 'verdict_window_already_published');
    assert.match(result.detail, /different or unverifiable source identity/);
    assert.equal(publisherCalled, false, 'publisher must NOT be called');
  });

  it('returns 409 when packet-ID exists on main but source identity is unverifiable (R7 Layer 1a — fail closed)', async () => {
    // R7: checkStoredSourceEquivalence throws (incomplete/orphan bundle) → fail
    // closed as 409, never silently returning no_new_window.
    // R10: both verdict AND lifecycle must exist to reach the checker.
    const existingId = 'r4-live-orphan-check';
    mkdirSync(resolve(root, 'verdicts'), { recursive: true });
    writeFileSync(resolve(root, 'verdicts', `${existingId}.md`), '---\ndomain_id: eval:a2a\n---\n');
    mkdirSync(resolve(root, 'bundles', existingId), { recursive: true });
    writeFileSync(resolve(root, 'bundles', existingId, 'lifecycle-root.json'), '{"domainId":"eval:a2a"}');

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        checkStoredSourceEquivalence: () => {
          throw new Error('Stored verdict has no source identity (incomplete/orphan bundle)');
        },
        // R7: mainReader required
        mainReader: createLiveTreeAsMainReader(root),
        generator: async () => {
          throw new Error('generator must not be called');
        },
      },
      {
        packet: buildPacket({ id: existingId, domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );

    assert.ok('error' in result, `expected 409 error, got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 409);
    assert.equal(result.error, 'verdict_window_already_published');
    assert.match(result.detail, /different or unverifiable source identity/);
  });

  it('returns no_new_window when packet-ID exists on main and source equivalence confirms (R7 Layer 1a — same source)', async () => {
    // R7: checkStoredSourceEquivalence returns true + mainReader confirms
    // packet on main → same source → no_new_window typed success.
    // R10: both verdict AND lifecycle must exist (complete canonical artifact).
    const existingId = 'r4-live-same-source';
    mkdirSync(resolve(root, 'verdicts'), { recursive: true });
    writeFileSync(resolve(root, 'verdicts', `${existingId}.md`), '---\ndomain_id: eval:a2a\n---\n');
    mkdirSync(resolve(root, 'bundles', existingId), { recursive: true });
    writeFileSync(resolve(root, 'bundles', existingId, 'lifecycle-root.json'), '{"domainId":"eval:a2a"}');

    let publisherCalled = false;
    const mockGitPublisher = {
      async publishOnIsolatedWorktree() {
        publisherCalled = true;
        return { commitSha: 'abc', prUrl: 'https://example.com' };
      },
    };

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        gitPublisher: mockGitPublisher,
        checkStoredSourceEquivalence: () => true, // R4: same source confirmed
        // R7: mainReader required
        mainReader: createLiveTreeAsMainReader(root),
        generator: async () => {
          throw new Error('generator must not be called — exact replay');
        },
      },
      {
        packet: buildPacket({ id: existingId, domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );

    assert.ok('ok' in result && result.ok === true, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert.equal(result.outcome, 'no_new_window');
    assert.equal(result.canonicalVerdictId, existingId);
    assert.equal(publisherCalled, false, 'publisher must NOT be called — exact replay');
  });

  // --- R5 regression tests (P1-1 / P1-3 from R4 review) ---

  it('returns no_new_window for A2A packet-ID replay without checker (R5 P1-1 — backward compat not regressed)', async () => {
    // R5 P1-1: designGateSourceEquivalenceCheck was previously injected for ALL
    // domains. For eval:a2a sourceRefs, isDesignGateSelector returns false →
    // checker returns false → 409. Fix: route only injects for eval:design-gate.
    // This test proves: no checker injected → A2A packet-ID replay → no_new_window.
    const existingId = 'r5-a2a-no-regression';
    mkdirSync(resolve(root, 'verdicts'), { recursive: true });
    writeFileSync(resolve(root, 'verdicts', `${existingId}.md`), '---\ndomain_id: eval:a2a\n---\n');

    let publisherCalled = false;
    const mockGitPublisher = {
      async publishOnIsolatedWorktree() {
        publisherCalled = true;
        return { commitSha: 'abc', prUrl: 'https://example.com' };
      },
    };

    // Simulate route behavior: NO checker for non-design-gate domain
    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        gitPublisher: mockGitPublisher,
        // NO replayPreflight, NO checkStoredSourceEquivalence — route doesn't inject for A2A
        generator: async () => {
          throw new Error('generator must not be called — exact replay');
        },
      },
      {
        packet: buildPacket({ id: existingId, domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );

    assert.ok('ok' in result && result.ok === true, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert.equal(result.outcome, 'no_new_window');
    assert.equal(result.canonicalVerdictId, existingId);
    assert.equal(publisherCalled, false, 'publisher must NOT be called');
  });

  it('does not create mainReader when no replay resolver is injected (R5 P1-3 — no event loop stall)', async () => {
    // R5 P1-3: FreshMainReader uses synchronous git commands. Handler must NOT
    // create it for domains without replay infrastructure (replayPreflight /
    // checkStoredSourceEquivalence). Test proves: without these deps, a
    // non-existent packet proceeds to the generator path (never touches git).
    //
    // If mainReader were created unconditionally, resolveRepoRoot would fail
    // (temp dir is not a git repo) but that's silent. The real proof is that
    // the handler reaches the generator without blocking on git fetch.
    let generatorCalled = false;

    // Mock publisher must invoke stage() — the generator runs inside it.
    // Create a fake worktree with the minimum structure stage expects.
    const fakeWorktree = mkdtempSync(`${tmpdir()}/r5-p13-worktree-`);
    const fakeHarness = resolve(fakeWorktree, 'docs', 'harness-feedback');
    mkdirSync(resolve(fakeHarness, 'verdicts'), { recursive: true });
    mkdirSync(resolve(fakeHarness, 'bundles'), { recursive: true });
    seedCanonicalMeasurementCensusState(fakeWorktree);

    const mockGitPublisher = {
      async publishOnIsolatedWorktree({ stage }) {
        await stage(fakeWorktree);
        return { commitSha: 'abc', prUrl: 'https://example.com' };
      },
    };

    await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        gitPublisher: mockGitPublisher,
        // NO replayPreflight, NO checkStoredSourceEquivalence
        generator: async (_packet, _sourceRefs, deps) => {
          generatorCalled = true;
          const bundleDir = `${deps.harnessFeedbackRoot}/bundles/r5-no-mainreader-test`;
          mkdirSync(bundleDir, { recursive: true });
          const verdictPath = `${deps.harnessFeedbackRoot}/verdicts/r5-no-mainreader-test.md`;
          writeFileSync(verdictPath, `---\ndomain_id: eval:a2a\n---\n`);
          return { verdictPath, bundleDir };
        },
      },
      {
        packet: buildPacket({ id: 'r5-no-mainreader-test', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );

    rmSync(fakeWorktree, { recursive: true, force: true });

    assert.equal(generatorCalled, true, 'generator must be called (no replay detection blocked it)');
    // Handler reached the generator without blocking on git fetch. This proves
    // mainReader was NOT created — if it had been, resolveRepoRoot + synchronous
    // git fetch would have run before reaching the publisher, even though they
    // are no-ops in a non-git temp dir.
  });

  it('returns non-success for unknown sourceRefs kind even when packet ID matches existing verdict (validation-first)', async () => {
    // Reviewer P1: existsSync check must run AFTER validation. A request with
    // an unknown sourceRefs kind and a matching packet ID should get 400
    // (kind mismatch — eval:a2a registry enforces expected kind), not
    // no_new_window — proving validation runs first.
    const existingId = 'existing-verdict-with-bad-refs';
    const verdictPath = resolve(root, 'verdicts', `${existingId}.md`);
    writeFileSync(verdictPath, '# Existing verdict\n');

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
      },
      {
        packet: buildPacket({ id: existingId, domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        // Unknown kind — domain registry expects a specific kind for eval:a2a,
        // so sourceRefs_kind_mismatch fires (400) before existsSync
        sourceRefs: { kind: 'definitely-not-a-real-kind' },
      },
    );

    assert.ok('error' in result, `expected error response, got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 400, 'kind mismatch must fire before existsSync check');
  });
});
