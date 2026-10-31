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

/**
 * F192 no_new_window typed success — exact replay detection.
 *
 * When a caller re-publishes a verdict with the same packet ID that already
 * exists on origin/main (exact replay), the handler MUST return a typed success
 * { ok: true, outcome: 'no_new_window', canonicalVerdictId } with zero side
 * effects (no worktree, no commit, no push, no PR) — NOT a 409 error.
 *
 * This distinguishes exact replays (expected no-op) from genuine window
 * collisions (different packet ID, same window → still 409).
 */
describe('handlePublishVerdict — no_new_window typed success for exact replay', () => {
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

  it('returns no_new_window when packet ID already has verdict file in live tree', async () => {
    // Seed existing verdict in harness feedback root (simulates fresh API checkout)
    const existingId = 'replay-existing-verdict';
    mkdirSync(resolve(root, 'verdicts'), { recursive: true });
    writeFileSync(resolve(root, 'verdicts', `${existingId}.md`), '---\ndomain_id: eval:a2a\n---\n');

    let publisherCalled = false;
    const mockGitPublisher = {
      async publishOnIsolatedWorktree() {
        publisherCalled = true;
        return { commitSha: 'abc123', prUrl: 'https://example.com' };
      },
    };

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        gitPublisher: mockGitPublisher,
        generator: async () => {
          throw new Error('generator must not be called for exact replay');
        },
      },
      {
        packet: buildPacket({ id: existingId, domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );

    // Must be typed success, not 409 error
    assert.ok('ok' in result && result.ok === true, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert.equal(result.outcome, 'no_new_window');
    assert.equal(result.canonicalVerdictId, existingId);
    assert.equal(publisherCalled, false, 'gitPublisher must NOT be called — zero side effects');
  });

  it('returns no_new_window when packet ID already has bundle dir in live tree', async () => {
    const existingId = 'replay-existing-bundle';
    mkdirSync(resolve(root, 'bundles', existingId), { recursive: true });

    let publisherCalled = false;
    const mockGitPublisher = {
      async publishOnIsolatedWorktree() {
        publisherCalled = true;
        return { commitSha: 'abc123', prUrl: 'https://example.com' };
      },
    };

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        gitPublisher: mockGitPublisher,
        generator: async () => {
          throw new Error('generator must not be called for exact replay');
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
    assert.equal(publisherCalled, false, 'gitPublisher must NOT be called — zero side effects');
  });

  it('returns no_new_window when isolated worktree catches verdict_already_exists_on_main (stale live tree)', async () => {
    // Simulate: live tree is stale (no existsSync hit), but isolated worktree
    // freshly checked out from origin/main detects the dup → throws verdict_already_exists_on_main.
    // Handler catch block must convert this to typed success, not 409.
    const existingId = 'replay-stale-livetree';

    const mockGitPublisher = {
      async publishOnIsolatedWorktree(_opts) {
        const fakeWorktree = mkdtempSync(`${tmpdir()}/phase-h-replay-`);
        seedCanonicalMeasurementCensusState(fakeWorktree);
        // The stage() authoritative check on isolated worktree detects dup
        throw new Error(
          `verdict_already_exists_on_main: packet.id '${existingId}' already exists on origin/main. Pick a different id.`,
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
        packet: buildPacket({ id: existingId, domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );

    // Must be typed success, not 409 error
    assert.ok('ok' in result && result.ok === true, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert.equal(result.outcome, 'no_new_window');
    assert.equal(result.canonicalVerdictId, existingId);
  });

  it('returns no_new_window when contract runner catches verdict_window_already_published and source equivalence confirms (production RED path)', async () => {
    // Production RED from @codex-sol: scheduler re-fires with a NEW packet ID
    // for the same domain/window. The contract runner's assertWindowsUnpublished
    // detects the window collision AFTER stage+commit and throws
    // verdict_window_already_published. R3: catch block verifies source equivalence
    // before returning typed success.
    const newPacketId = 'replay-new-packet-id';
    const existingCanonicalId = 'original-published-verdict';

    const mockGitPublisher = {
      async publishOnIsolatedWorktree(_opts) {
        throw new Error(
          `verdict_window_already_published: ${newPacketId} conflicts with existing verdict ${existingCanonicalId}`,
        );
      },
    };

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        gitPublisher: mockGitPublisher,
        checkStoredSourceEquivalence: () => true, // R3: source equivalence confirmed
        // R7: mainReader required for source-verified typed success
        mainReader: createLiveTreeAsMainReader(root),
        generator: async () => {
          throw new Error('generator should not be called in this mock');
        },
      },
      {
        packet: buildPacket({ id: newPacketId, domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );

    assert.ok('ok' in result && result.ok === true, `expected ok:true, got: ${JSON.stringify(result)}`);
    assert.equal(result.outcome, 'no_new_window');
    // Must use the STORED canonical ID from origin/main, not the new packet ID
    assert.equal(result.canonicalVerdictId, existingCanonicalId);
  });

  it('returns no_new_window via preflight when stored bundle has same source identity (Layer 1b — publisher skipped)', async () => {
    // R3 Layer 1b: domain-specific preflight scans live-tree bundles for
    // (domain, window) match and compares sourceMapId. Same sourceMapId →
    // replay → no_new_window with zero side effects (publisher never called).
    const storedVerdictId = 'preflight-same-source-bundle';
    const sourceMapId = 'f303-phase-c-test-map';
    const domainId = 'eval:design-gate';

    // Seed stored bundle
    const bundlePath = resolve(root, 'bundles', storedVerdictId);
    mkdirSync(resolve(bundlePath, 'raw'), { recursive: true });
    writeFileSync(resolve(bundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId }));
    writeFileSync(resolve(bundlePath, 'snapshot.json'), JSON.stringify({ window: { startMs: 1000, endMs: 2000 } }));
    writeFileSync(
      resolve(bundlePath, 'raw', 'episode-source-refs.json'),
      JSON.stringify({ selector: { kind: 'design-gate-episode-source-map', sourceMapId } }),
    );

    // Seed source map YAML (incoming window resolution)
    const sourceMapDir = resolve(root, 'design-gate', 'source-maps');
    mkdirSync(sourceMapDir, { recursive: true });
    writeFileSync(resolve(sourceMapDir, `${sourceMapId}.yaml`), 'startMs: 1000\nendMs: 2000\n');

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
        // R6: inject mainReader — temp dir is not a git repo, so handler can't
        // create one from resolveRepoRoot. Preflight fails closed without it.
        mainReader: createLiveTreeAsMainReader(root),
        generator: async () => {
          throw new Error('generator must not be called — preflight should short-circuit');
        },
      },
      {
        packet: buildPacket({ id: 'new-packet-same-source', domainId }),
        domain: domainId,
        catId: 'opus',
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId },
      },
    );

    assert.ok(!('error' in result), `expected no_new_window success, got: ${JSON.stringify(result)}`);
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'no_new_window');
    assert.equal(result.canonicalVerdictId, storedVerdictId);
    assert.equal(publisherCalled, false, 'publisher must NOT be called — preflight caught the replay');
  });

  it('returns 409 via preflight when stored bundle has different source identity (Layer 1b — publisher skipped)', async () => {
    // R3 Layer 1b: same window but different sourceMapId → conflict → 409.
    // Publisher must NOT be called.
    const storedVerdictId = 'preflight-diff-source-bundle';
    const domainId = 'eval:design-gate';

    // Seed stored bundle with sourceMapId A
    const bundlePath = resolve(root, 'bundles', storedVerdictId);
    mkdirSync(resolve(bundlePath, 'raw'), { recursive: true });
    writeFileSync(resolve(bundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId }));
    writeFileSync(resolve(bundlePath, 'snapshot.json'), JSON.stringify({ window: { startMs: 3000, endMs: 4000 } }));
    writeFileSync(
      resolve(bundlePath, 'raw', 'episode-source-refs.json'),
      JSON.stringify({ selector: { kind: 'design-gate-episode-source-map', sourceMapId: 'stored-map-a' } }),
    );

    // Seed source map YAML for incoming sourceMapId (same window, different source)
    const sourceMapDir = resolve(root, 'design-gate', 'source-maps');
    mkdirSync(sourceMapDir, { recursive: true });
    writeFileSync(resolve(sourceMapDir, 'incoming-map-b.yaml'), 'startMs: 3000\nendMs: 4000\n');

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
        packet: buildPacket({ id: 'conflict-packet-diff-source', domainId }),
        domain: domainId,
        catId: 'opus',
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId: 'incoming-map-b' },
      },
    );

    assert.ok('error' in result, `expected 409 error, got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 409);
    assert.equal(result.error, 'verdict_window_already_published');
    assert.equal(publisherCalled, false, 'publisher must NOT be called — preflight caught the conflict');
  });
});
