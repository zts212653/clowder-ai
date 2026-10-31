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
 * R7 — Canonical replay authority handler-level tests.
 *
 * These test the FULL handler pipeline to verify that no_new_window is never
 * emitted without canonical proof from origin/main. Each test targets one of
 * the exits that R6 left open (reviewer P1 findings).
 */
describe('handlePublishVerdict — R7 canonical replay authority', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = setupHarnessFeedback();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('proceeds to publisher when mainReader unavailable — live same packet/source is not typed success (R7-1)', async () => {
    // R7 P1 finding #1: mainReader null + live packet exists with same source.
    // Old behavior: Layer 1a returned no_new_window from live tree.
    // R7: without mainReader, cannot confirm canonical state → proceed to publisher.
    const existingId = 'r7-no-reader-live-same';

    // Seed live-tree verdict + bundle with source refs
    mkdirSync(resolve(root, 'verdicts'), { recursive: true });
    writeFileSync(resolve(root, 'verdicts', `${existingId}.md`), '---\ndomain_id: eval:design-gate\n---\n');
    const bundlePath = resolve(root, 'bundles', existingId);
    mkdirSync(resolve(bundlePath, 'raw'), { recursive: true });
    writeFileSync(resolve(bundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId: 'eval:design-gate' }));
    writeFileSync(
      resolve(bundlePath, 'raw', 'episode-source-refs.json'),
      JSON.stringify({ selector: { kind: 'design-gate-episode-source-map', sourceMapId: 'r7-test-map' } }),
    );

    const { designGateSourceEquivalenceCheck } = await import(
      '../../dist/infrastructure/harness-eval/design-gate/design-gate-replay-preflight.js'
    );

    let publisherCalled = false;
    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        checkStoredSourceEquivalence: designGateSourceEquivalenceCheck,
        // NO mainReader — simulates git fetch failure
        gitPublisher: {
          async publishOnIsolatedWorktree() {
            publisherCalled = true;
            // Publisher finds it on its own fresh worktree
            throw new Error(`verdict_already_exists_on_main: packet.id '${existingId}' already exists on origin/main.`);
          },
        },
        generator: async (packet, _sourceRefs, deps) => {
          const bd = `${deps.harnessFeedbackRoot}/bundles/${packet.id}`;
          mkdirSync(bd, { recursive: true });
          return { verdictPath: `${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`, bundleDir: bd };
        },
      },
      {
        packet: buildPacket({ id: existingId, domainId: 'eval:design-gate' }),
        domain: 'eval:design-gate',
        catId: 'opus',
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId: 'r7-test-map' },
      },
    );

    // R7: must NOT return no_new_window — mainReader unavailable means we can't
    // verify canonical state. Publisher runs, hits verdict_already_exists_on_main,
    // but post-publish collision also requires mainReader → falls through to 409.
    assert.equal(publisherCalled, true, 'publisher must be called — cannot confirm canonical state without mainReader');
    assert.ok('error' in result, `expected error (not typed success), got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 409);
  });

  it('proceeds to publisher when main has no bundle but live does — live-only is not canonical (R7-2)', async () => {
    // R7 P1 finding #2: main has no matching bundle, live has same-source bundle.
    // Old behavior: preflight scanLiveTreeBundles returned replay from live.
    // R7: live-only is an in-flight/abandoned artifact, not canonical proof.
    const storedVerdictId = 'r7-live-only-inflight';
    const sourceMapId = 'r7-live-only-map';
    const domainId = 'eval:design-gate';

    // Seed source map YAML on live tree
    const sourceMapDir = resolve(root, 'design-gate', 'source-maps');
    mkdirSync(sourceMapDir, { recursive: true });
    writeFileSync(resolve(sourceMapDir, `${sourceMapId}.yaml`), 'startMs: 500000\nendMs: 600000\n');

    // Seed live-tree bundle with same sourceMapId
    const liveBundlePath = resolve(root, 'bundles', storedVerdictId);
    mkdirSync(resolve(liveBundlePath, 'raw'), { recursive: true });
    writeFileSync(resolve(liveBundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId }));
    writeFileSync(
      resolve(liveBundlePath, 'snapshot.json'),
      JSON.stringify({ window: { startMs: 500000, endMs: 600000 } }),
    );
    writeFileSync(
      resolve(liveBundlePath, 'raw', 'episode-source-refs.json'),
      JSON.stringify({ selector: { kind: 'design-gate-episode-source-map', sourceMapId } }),
    );

    // Mock mainReader: origin/main has the source map but NO matching bundle
    const mockMainReader = {
      listBundleEntries() {
        return []; // no bundles on main
      },
      readFile(relativePath) {
        // Source map YAML exists on main (window resolution)
        if (relativePath === `design-gate/source-maps/${sourceMapId}.yaml`) {
          return 'startMs: 500000\nendMs: 600000\n';
        }
        return null; // no bundle data on main
      },
    };

    const { designGateReplayPreflight, designGateSourceEquivalenceCheck } = await import(
      '../../dist/infrastructure/harness-eval/design-gate/design-gate-replay-preflight.js'
    );

    let publisherCalled = false;
    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        replayPreflight: designGateReplayPreflight,
        checkStoredSourceEquivalence: designGateSourceEquivalenceCheck,
        mainReader: mockMainReader,
        gitPublisher: {
          async publishOnIsolatedWorktree(opts) {
            publisherCalled = true;
            const fakeWorktree = mkdtempSync(`${tmpdir()}/r7-publish-`);
            seedCanonicalMeasurementCensusState(fakeWorktree);
            await opts.stage(fakeWorktree);
            return { commitSha: 'r7abc', prUrl: 'https://example.com/pr/r7' };
          },
        },
        generator: async (packet, _sourceRefs, deps) => {
          const bd = `${deps.harnessFeedbackRoot}/bundles/${packet.id}`;
          mkdirSync(bd, { recursive: true });
          const vp = `${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`;
          writeFileSync(vp, `---\ndomain_id: ${packet.domainId}\n---\n`);
          return { verdictPath: vp, bundleDir: bd };
        },
      },
      {
        packet: buildPacket({ id: 'r7-new-publish', domainId }),
        domain: domainId,
        catId: 'opus',
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId },
      },
    );

    // R7: live-only bundle is NOT canonical proof. Publisher must run.
    assert.equal(publisherCalled, true, 'publisher must be called — live-only is not canonical proof');
    // Publisher succeeded → normal success (not no_new_window)
    const isNoNewWindow = 'ok' in result && result.ok === true && result.outcome === 'no_new_window';
    assert.equal(isNoNewWindow, false, 'must NOT return no_new_window from live-only bundle');
  });

  it('returns 409 when verdict_already_exists_on_main has non-equivalent source (R7-3)', async () => {
    // R7 P1 finding #3: verdict_already_exists_on_main was blindly accepted as
    // replay without checking source identity. With source checker returning false,
    // should be 409 (source mismatch), not no_new_window.
    const existingId = 'r7-main-diff-source-packet';

    const mockGitPublisher = {
      async publishOnIsolatedWorktree() {
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
        checkStoredSourceEquivalence: () => false, // R7: different source identity
        mainReader: createLiveTreeAsMainReader(root),
        generator: async (packet, _sourceRefs, deps) => {
          const bd = `${deps.harnessFeedbackRoot}/bundles/${packet.id}`;
          mkdirSync(bd, { recursive: true });
          return { verdictPath: `${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`, bundleDir: bd };
        },
      },
      {
        packet: buildPacket({ id: existingId, domainId: 'eval:design-gate' }),
        domain: 'eval:design-gate',
        catId: 'opus',
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId: 'r7-diff-map' },
      },
    );

    // R7: same packet ID on main but different source → 409, not no_new_window
    assert.ok('error' in result, `expected 409 error, got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 409);
    assert.equal(result.error, 'verdict_already_exists');
  });

  it('returns 409 when verdict_window_already_published without mainReader — no live fallback (R7-4)', async () => {
    // R7 P1 finding #4: late window collision without mainReader used to fall
    // back to live-tree data for source verification. R7: without mainReader,
    // can't verify source → falls through to error mapping → 409.
    const existingId = 'r7-late-collision-no-reader';

    const mockGitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        const fakeWorktree = mkdtempSync(`${tmpdir()}/r7-collision-`);
        seedCanonicalMeasurementCensusState(fakeWorktree);
        await opts.stage(fakeWorktree);
        throw new Error(`verdict_window_already_published: r7-new conflicts with existing verdict ${existingId}`);
      },
    };

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        gitPublisher: mockGitPublisher,
        checkStoredSourceEquivalence: () => true, // Would return true, but mainReader absent
        // NO mainReader — R7: can't verify via live data
        generator: async (packet, _sourceRefs, deps) => {
          const bd = `${deps.harnessFeedbackRoot}/bundles/${packet.id}`;
          mkdirSync(bd, { recursive: true });
          const vp = `${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`;
          writeFileSync(vp, `---\ndomain_id: ${packet.domainId}\n---\n`);
          return { verdictPath: vp, bundleDir: bd };
        },
      },
      {
        packet: buildPacket({ id: 'r7-new', domainId: 'eval:a2a' }),
        domain: 'eval:a2a',
        catId: 'codex',
        sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
      },
    );

    // R7: without mainReader, can't verify source → error mapping → 409
    assert.ok('error' in result, `expected 409 error (not typed success), got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 409);
    assert.equal(result.error, 'verdict_window_already_published');
  });
});

/**
 * R3 P1 #2 — stale live-tree duplicate check: isolated worktree from
 * origin/main already has the verdict. Stage callback must throw
 * verdict_already_exists_on_main, handler surfaces no_new_window not 500.
 *
 * Moved from publish-verdict-pipeline.test.js per 350-line hard limit.
 */
describe('handlePublishVerdict — stale live-tree no_new_window (R3 P1 #2)', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = setupHarnessFeedback();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns no_new_window typed success when verdict file pre-exists in isolated worktree (live tree was stale)', async () => {
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
    assert.ok('ok' in result && result.ok === true, `expected typed success, got: ${JSON.stringify(result)}`);
    assert.equal(result.outcome, 'no_new_window');
    assert.equal(result.canonicalVerdictId, 'stale-test');
  });
});
