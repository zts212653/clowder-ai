import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket } from './publish-verdict-fixtures.js';

/**
 * R6 — Main-first authority + fail-closed without mainReader.
 *
 * R6 review P1: live-tree-first scanning allows stale bundles to suppress
 * canonical origin/main identity. These tests prove:
 * 1. Live says replay, fresh main says conflict → 409 (main wins)
 * 3. No mainReader (git fetch failed) → preflight returns null (fail closed)
 * 4. Layer 1a packet-ID path receives mainReader for source verification
 */
describe('designGateReplayPreflight — R6 main-first authority', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = mkdtempSync(`${tmpdir()}/dg-preflight-r6-`);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns conflict when live bundle says same source but fresh main says different (R6 test 1)', async () => {
    // Counterexample from reviewer: live has source-old matching the incoming
    // sourceMapId, but origin/main has a bundle with source-new for the same
    // window. With main-first scanning, main's conflict must win over live's
    // replay — returning 409 instead of no_new_window.
    const incomingSourceMapId = 'r6-source-old';
    const domainId = 'eval:design-gate';
    const storedVerdictIdLive = 'r6-live-stale-bundle';
    const storedVerdictIdMain = 'r6-main-authoritative-bundle';

    // Seed source map YAML on live tree (for incoming window resolution fallback)
    const sourceMapDir = resolve(root, 'design-gate', 'source-maps');
    mkdirSync(sourceMapDir, { recursive: true });
    writeFileSync(resolve(sourceMapDir, `${incomingSourceMapId}.yaml`), 'startMs: 100000\nendMs: 200000\n');

    // Seed live-tree bundle with SAME sourceMapId (live says "replay")
    const liveBundlePath = resolve(root, 'bundles', storedVerdictIdLive);
    mkdirSync(resolve(liveBundlePath, 'raw'), { recursive: true });
    writeFileSync(resolve(liveBundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId }));
    writeFileSync(
      resolve(liveBundlePath, 'snapshot.json'),
      JSON.stringify({ window: { startMs: 100000, endMs: 200000 } }),
    );
    writeFileSync(
      resolve(liveBundlePath, 'raw', 'episode-source-refs.json'),
      JSON.stringify({ selector: { kind: 'design-gate-episode-source-map', sourceMapId: incomingSourceMapId } }),
    );

    // Mock mainReader: origin/main has a bundle with DIFFERENT sourceMapId (main says "conflict")
    const mockMainReader = {
      listBundleEntries() {
        return [storedVerdictIdMain];
      },
      readFile(relativePath) {
        // Source map YAML — main also provides the window
        if (relativePath === `design-gate/source-maps/${incomingSourceMapId}.yaml`) {
          return 'startMs: 100000\nendMs: 200000\n';
        }
        if (relativePath === `bundles/${storedVerdictIdMain}/lifecycle-root.json`) {
          return JSON.stringify({ domainId });
        }
        if (relativePath === `bundles/${storedVerdictIdMain}/snapshot.json`) {
          return JSON.stringify({ window: { startMs: 100000, endMs: 200000 } });
        }
        if (relativePath === `bundles/${storedVerdictIdMain}/raw/episode-source-refs.json`) {
          return JSON.stringify({
            selector: { kind: 'design-gate-episode-source-map', sourceMapId: 'r6-source-new' },
          });
        }
        return null;
      },
    };

    const { designGateReplayPreflight } = await import(
      '../../dist/infrastructure/harness-eval/design-gate/design-gate-replay-preflight.js'
    );

    const result = await designGateReplayPreflight(
      { kind: 'design-gate-episode-source-map', sourceMapId: incomingSourceMapId },
      { harnessFeedbackRoot: root, domainId, mainReader: mockMainReader },
    );

    // Main is authoritative: conflict from main must win over replay from live
    assert.ok(result, 'preflight must detect the collision from origin/main');
    assert.equal(result.kind, 'conflict', 'main says different source → conflict, not replay');
    assert.equal(result.storedVerdictId, storedVerdictIdMain);
    assert.match(result.detail, /source differs/);
  });

  it('returns null when mainReader is unavailable — fail closed (R6 test 3)', async () => {
    // R6: if git fetch fails → mainReader is null → preflight must return null
    // (fail closed). The publisher's own worktree will do the authoritative
    // check. Live-tree-only results are not trusted.
    const sourceMapId = 'r6-no-mainreader-map';
    const domainId = 'eval:design-gate';

    // Seed source map YAML + matching bundle on live tree
    const sourceMapDir = resolve(root, 'design-gate', 'source-maps');
    mkdirSync(sourceMapDir, { recursive: true });
    writeFileSync(resolve(sourceMapDir, `${sourceMapId}.yaml`), 'startMs: 300000\nendMs: 400000\n');

    const liveBundlePath = resolve(root, 'bundles', 'r6-live-only-bundle');
    mkdirSync(resolve(liveBundlePath, 'raw'), { recursive: true });
    writeFileSync(resolve(liveBundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId }));
    writeFileSync(
      resolve(liveBundlePath, 'snapshot.json'),
      JSON.stringify({ window: { startMs: 300000, endMs: 400000 } }),
    );
    writeFileSync(
      resolve(liveBundlePath, 'raw', 'episode-source-refs.json'),
      JSON.stringify({ selector: { kind: 'design-gate-episode-source-map', sourceMapId } }),
    );

    const { designGateReplayPreflight } = await import(
      '../../dist/infrastructure/harness-eval/design-gate/design-gate-replay-preflight.js'
    );

    // NO mainReader — simulates git fetch failure
    const result = await designGateReplayPreflight(
      { kind: 'design-gate-episode-source-map', sourceMapId },
      { harnessFeedbackRoot: root, domainId, mainReader: undefined },
    );

    // Must return null (fail closed) — live-tree data alone is not authoritative
    assert.equal(result, null, 'preflight must fail closed without mainReader, even when live tree has matching data');
  });

  it('passes mainReader to Layer 1a equivalence checker for main-only source identity (R7 test 4)', async () => {
    // R7: Layer 1a packet-ID path checks origin/main for packet existence
    // via mainReader, then passes mainReader to the equivalence checker
    // for source identity when source refs are only on main (stale live tree).
    const existingId = 'r6-layer1a-main-only-source';
    const r6Root = setupHarnessFeedback();

    // Seed verdict file on live tree (packet-ID exists on live too)
    writeFileSync(resolve(r6Root, 'verdicts', `${existingId}.md`), '---\ndomain_id: eval:design-gate\n---\n');

    // Seed bundle on live tree WITHOUT source refs (simulates stale live tree)
    const liveBundlePath = resolve(r6Root, 'bundles', existingId);
    mkdirSync(resolve(liveBundlePath, 'raw'), { recursive: true });
    writeFileSync(resolve(liveBundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId: 'eval:design-gate' }));
    // NO raw/episode-source-refs.json on live tree

    const sourceMapId = 'r6-layer1a-test-map';

    // R7: Mock mainReader must serve BOTH packet existence paths (for Layer 1a
    // canonical check) AND source refs (for equivalence verification).
    const mockMainReader = {
      listBundleEntries() {
        return [existingId];
      },
      readFile(relativePath) {
        // R7: Layer 1a checks verdict existence on main
        if (relativePath === `verdicts/${existingId}.md`) {
          return '---\ndomain_id: eval:design-gate\n---\n';
        }
        // R7: Layer 1a checks bundle existence on main
        if (relativePath === `bundles/${existingId}/lifecycle-root.json`) {
          return JSON.stringify({ domainId: 'eval:design-gate' });
        }
        // Source refs from origin/main (same sourceMapId → replay)
        if (relativePath === `bundles/${existingId}/raw/episode-source-refs.json`) {
          return JSON.stringify({
            selector: { kind: 'design-gate-episode-source-map', sourceMapId },
          });
        }
        return null;
      },
    };

    const { designGateSourceEquivalenceCheck } = await import(
      '../../dist/infrastructure/harness-eval/design-gate/design-gate-replay-preflight.js'
    );

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: r6Root,
        now: () => new Date('2026-06-05T11:00:01.000Z'),
        checkStoredSourceEquivalence: designGateSourceEquivalenceCheck,
        mainReader: mockMainReader,
        generator: async () => {
          throw new Error('generator must not be called — exact replay via Layer 1a');
        },
      },
      {
        packet: buildPacket({ id: existingId, domainId: 'eval:design-gate' }),
        domain: 'eval:design-gate',
        catId: 'opus',
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId },
      },
    );

    rmSync(r6Root, { recursive: true, force: true });

    // Layer 1a must use mainReader fallback to read source refs → same sourceMapId → no_new_window
    assert.ok(!('error' in result), `expected no_new_window success, got: ${JSON.stringify(result)}`);
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'no_new_window');
    assert.equal(result.canonicalVerdictId, existingId);
  });

  it('returns null when main source-map is unavailable — live YAML must not complete typed success (R10 test 5)', async () => {
    // R10 P1-2: if main source-map read returns null but live YAML exists,
    // the preflight MUST NOT use the live-derived window for scanning main
    // bundles (typed success). Live data may allow proceed, but typed
    // replay/conflict decisions require main-derived windows.
    const sourceMapId = 'r10-main-unavailable-source-map';
    const domainId = 'eval:design-gate';
    const storedBundleId = 'r10-matching-main-bundle';

    // Seed live source-map YAML (would give a valid window)
    const sourceMapDir = resolve(root, 'design-gate', 'source-maps');
    mkdirSync(sourceMapDir, { recursive: true });
    writeFileSync(resolve(sourceMapDir, `${sourceMapId}.yaml`), 'startMs: 500000\nendMs: 600000\n');

    // Mock mainReader: source-map read returns null (absent or git show error),
    // but has a matching bundle with same window
    const mockMainReader = {
      listBundleEntries() {
        return [storedBundleId];
      },
      readFile(relativePath) {
        // Source map is unavailable on main
        if (relativePath === `design-gate/source-maps/${sourceMapId}.yaml`) return null;
        // But a matching bundle exists on main
        if (relativePath === `bundles/${storedBundleId}/lifecycle-root.json`) {
          return JSON.stringify({ domainId });
        }
        if (relativePath === `bundles/${storedBundleId}/snapshot.json`) {
          return JSON.stringify({ window: { startMs: 500000, endMs: 600000 } });
        }
        if (relativePath === `bundles/${storedBundleId}/raw/episode-source-refs.json`) {
          return JSON.stringify({ selector: { kind: 'design-gate-episode-source-map', sourceMapId } });
        }
        return null;
      },
    };

    const { designGateReplayPreflight } = await import(
      '../../dist/infrastructure/harness-eval/design-gate/design-gate-replay-preflight.js'
    );

    const result = await designGateReplayPreflight(
      { kind: 'design-gate-episode-source-map', sourceMapId },
      { harnessFeedbackRoot: root, domainId, mainReader: mockMainReader },
    );

    // R10: main source-map unavailable → live YAML must NOT be used for typed success.
    // Even though main has a matching bundle, the window was not from canonical main data.
    // Preflight returns null (proceed to publisher for authoritative check).
    assert.equal(result, null, 'preflight must return null when source-map window cannot be derived from main');
  });
});
