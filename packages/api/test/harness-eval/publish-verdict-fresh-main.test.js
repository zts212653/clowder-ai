import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket, seedCanonicalMeasurementCensusState } from './publish-verdict-fixtures.js';

/**
 * R8 — Fresh-main authority handler-level tests.
 *
 * These verify that stale/contradictory live state cannot override fresh main
 * in post-collision resolution, that live-only bundles don't block the publisher,
 * and that post-collision re-resolution produces correct results when origin/main
 * advances after the pre-publish snapshot.
 */
describe('handlePublishVerdict — R8 fresh-main authority', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = setupHarnessFeedback();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns 409 when live source matches incoming but main source differs — post-collision (R8-1)', async () => {
    // R8 P1-a: designGateSourceEquivalenceCheck was live-first. Stale live
    // bundle has sourceMapId matching incoming, but fresh main has a different
    // sourceMapId. The old code returned true (live match), enabling typed success.
    // R8: main-first → returns false → 409.
    const existingId = 'r8-stale-live-packet';

    // Seed live-tree bundle with sourceMapId = stale-live-source
    const liveBundlePath = resolve(root, 'bundles', existingId);
    mkdirSync(resolve(liveBundlePath, 'raw'), { recursive: true });
    writeFileSync(resolve(liveBundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId: 'eval:design-gate' }));
    writeFileSync(
      resolve(liveBundlePath, 'raw', 'episode-source-refs.json'),
      JSON.stringify({ selector: { kind: 'design-gate-episode-source-map', sourceMapId: 'stale-live-source' } }),
    );

    // Mock mainReader: fresh main has sourceMapId = fresh-main-source (different)
    const freshMainReader = {
      listBundleEntries() {
        return [existingId];
      },
      readFile(relativePath) {
        if (relativePath === `bundles/${existingId}/raw/episode-source-refs.json`) {
          return JSON.stringify({
            selector: { kind: 'design-gate-episode-source-map', sourceMapId: 'fresh-main-source' },
          });
        }
        if (relativePath === `bundles/${existingId}/lifecycle-root.json`) {
          return JSON.stringify({ domainId: 'eval:design-gate' });
        }
        if (relativePath === `verdicts/${existingId}.md`) return '---\n---\n';
        return null;
      },
    };

    const { designGateSourceEquivalenceCheck } = await import(
      '../../dist/infrastructure/harness-eval/design-gate/design-gate-replay-preflight.js'
    );

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        checkStoredSourceEquivalence: designGateSourceEquivalenceCheck,
        mainReader: freshMainReader,
        createFreshMainReader: () => freshMainReader,
        gitPublisher: {
          async publishOnIsolatedWorktree() {
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
        // Incoming matches live (stale-live-source) but NOT main (fresh-main-source)
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId: 'stale-live-source' },
      },
    );

    // R8: main-first equivalence check → main says fresh-main-source ≠ stale-live-source → 409
    assert.ok('error' in result, `expected 409 error, got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 409);
  });

  it('proceeds to publisher when main has no bundle and live has different source (R8-2)', async () => {
    // R8 P1-b: R7 still returned 409 from live-only different-source bundles in
    // preflight. But a live-only artifact is not canonical evidence — the guarded
    // publisher should decide conflicts authoritatively from its own fresh origin/main.
    const liveConflictId = 'r8-live-only-conflict';
    const sourceMapId = 'r8-incoming-map';
    const domainId = 'eval:design-gate';

    // Seed source map YAML on live tree
    const sourceMapDir = resolve(root, 'design-gate', 'source-maps');
    mkdirSync(sourceMapDir, { recursive: true });
    writeFileSync(resolve(sourceMapDir, `${sourceMapId}.yaml`), 'startMs: 700000\nendMs: 800000\n');

    // Seed live-tree bundle with DIFFERENT sourceMapId
    const liveBundlePath = resolve(root, 'bundles', liveConflictId);
    mkdirSync(resolve(liveBundlePath, 'raw'), { recursive: true });
    writeFileSync(resolve(liveBundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId }));
    writeFileSync(
      resolve(liveBundlePath, 'snapshot.json'),
      JSON.stringify({ window: { startMs: 700000, endMs: 800000 } }),
    );
    writeFileSync(
      resolve(liveBundlePath, 'raw', 'episode-source-refs.json'),
      JSON.stringify({ selector: { kind: 'design-gate-episode-source-map', sourceMapId: 'different-source' } }),
    );

    // Mock mainReader: source map exists on main but NO matching bundle
    const mockMainReader = {
      listBundleEntries() {
        return [];
      },
      readFile(relativePath) {
        if (relativePath === `design-gate/source-maps/${sourceMapId}.yaml`) {
          return 'startMs: 700000\nendMs: 800000\n';
        }
        return null;
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
            const fakeWorktree = mkdtempSync(`${tmpdir()}/r8-proceed-`);
            seedCanonicalMeasurementCensusState(fakeWorktree);
            await opts.stage(fakeWorktree);
            return { commitSha: 'r8abc', prUrl: 'https://example.com/pr/r8' };
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
        packet: buildPacket({ id: 'r8-new-publish', domainId }),
        domain: domainId,
        catId: 'opus',
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId },
      },
    );

    // R8: live-only different-source is NOT canonical evidence. Publisher must run.
    assert.equal(publisherCalled, true, 'publisher must be called — live-only conflict is not canonical');
    const isNoNewWindow = 'ok' in result && result.ok === true && result.outcome === 'no_new_window';
    assert.equal(isNoNewWindow, false, 'must NOT return no_new_window');
    // Publisher succeeded → it's not 409 from a false conflict
    const is409 = 'error' in result && result.status === 409;
    assert.equal(is409, false, 'must NOT return 409 from live-only conflict');
  });

  it('returns no_new_window after post-collision re-resolve with fresh main (R8-3)', async () => {
    // R8 P1-c: pre-publish mainReader misses the bundle (concurrent winner hasn't
    // landed yet). Publisher finds the concurrent winner on its fresh origin/main
    // and throws verdict_window_already_published. Post-collision re-resolve
    // creates a fresh reader that now sees the winner with same source → no_new_window.
    const winnerId = 'r8-concurrent-winner';
    const sourceMapId = 'r8-shared-source';

    // Pre-publish mainReader: no bundles (the concurrent winner hasn't committed yet)
    const staleMainReader = {
      listBundleEntries() {
        return [];
      },
      readFile() {
        return null;
      },
    };

    // Post-collision fresh reader: now sees the concurrent winner with same source
    const freshMainReader = {
      listBundleEntries() {
        return [winnerId];
      },
      readFile(relativePath) {
        if (relativePath === `bundles/${winnerId}/raw/episode-source-refs.json`) {
          return JSON.stringify({
            selector: { kind: 'design-gate-episode-source-map', sourceMapId },
          });
        }
        if (relativePath === `bundles/${winnerId}/lifecycle-root.json`) {
          return JSON.stringify({ domainId: 'eval:design-gate' });
        }
        if (relativePath === `verdicts/${winnerId}.md`) return '---\n---\n';
        return null;
      },
    };

    const { designGateSourceEquivalenceCheck } = await import(
      '../../dist/infrastructure/harness-eval/design-gate/design-gate-replay-preflight.js'
    );

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        checkStoredSourceEquivalence: designGateSourceEquivalenceCheck,
        mainReader: staleMainReader,
        createFreshMainReader: () => freshMainReader,
        gitPublisher: {
          async publishOnIsolatedWorktree(opts) {
            const fakeWorktree = mkdtempSync(`${tmpdir()}/r8-collision-`);
            seedCanonicalMeasurementCensusState(fakeWorktree);
            await opts.stage(fakeWorktree);
            throw new Error(
              `verdict_window_already_published: r8-incoming conflicts with existing verdict ${winnerId}`,
            );
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
        packet: buildPacket({ id: 'r8-incoming', domainId: 'eval:design-gate' }),
        domain: 'eval:design-gate',
        catId: 'opus',
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId },
      },
    );

    // R8: post-collision re-resolve with fresh main → same source → no_new_window
    assert.ok('ok' in result && result.ok === true, `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.outcome, 'no_new_window');
    assert.equal(result.canonicalVerdictId, winnerId);
  });
});
