import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, before, describe, it } from 'node:test';

/**
 * R4 — designGateSourceEquivalenceCheck with FreshMainReader fallback.
 *
 * When the stored bundle is not on the live tree (stale checkout), the
 * equivalence check must fall back to ctx.mainReader to read source refs
 * from origin/main.
 */
describe('designGateSourceEquivalenceCheck — R4 mainReader fallback', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = mkdtempSync(`${tmpdir()}/dg-equiv-r4-`);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns true via mainReader fallback when live tree has no bundle (same source)', async () => {
    // R4: live tree bundle dir missing → readStoredSourceMapId returns null →
    // falls back to mainReader.readFile → finds matching sourceMapId → true.
    const storedVerdictId = 'main-only-equiv-same';
    const sourceMapId = 'equiv-test-source-a';

    // NO live tree bundles — stale checkout
    // mainReader provides the bundle data from origin/main
    const mockMainReader = {
      listBundleEntries() {
        return [];
      },
      readFile(relativePath) {
        // R9: lifecycle-root.json required for bundle-exists check on main
        if (relativePath === `bundles/${storedVerdictId}/lifecycle-root.json`) {
          return JSON.stringify({ domainId: 'eval:design-gate' });
        }
        if (relativePath === `bundles/${storedVerdictId}/raw/episode-source-refs.json`) {
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

    const result = await designGateSourceEquivalenceCheck(
      storedVerdictId,
      { kind: 'design-gate-episode-source-map', sourceMapId },
      { harnessFeedbackRoot: root, mainReader: mockMainReader },
    );

    assert.equal(result, true, 'same sourceMapId from mainReader fallback must return true');
  });

  it('returns false via mainReader fallback when live tree has no bundle (different source)', async () => {
    // R4: mainReader finds bundle but stored sourceMapId differs from incoming.
    const storedVerdictId = 'main-only-equiv-diff';

    const mockMainReader = {
      listBundleEntries() {
        return [];
      },
      readFile(relativePath) {
        // R9: lifecycle-root.json required for bundle-exists check on main
        if (relativePath === `bundles/${storedVerdictId}/lifecycle-root.json`) {
          return JSON.stringify({ domainId: 'eval:design-gate' });
        }
        if (relativePath === `bundles/${storedVerdictId}/raw/episode-source-refs.json`) {
          return JSON.stringify({
            selector: { kind: 'design-gate-episode-source-map', sourceMapId: 'stored-source-x' },
          });
        }
        return null;
      },
    };

    const { designGateSourceEquivalenceCheck } = await import(
      '../../dist/infrastructure/harness-eval/design-gate/design-gate-replay-preflight.js'
    );

    const result = await designGateSourceEquivalenceCheck(
      storedVerdictId,
      { kind: 'design-gate-episode-source-map', sourceMapId: 'incoming-source-y' },
      { harnessFeedbackRoot: root, mainReader: mockMainReader },
    );

    assert.equal(result, false, 'different sourceMapId from mainReader fallback must return false');
  });

  it('throws when neither live tree nor mainReader has source identity (fail closed)', async () => {
    // R4: both live tree and mainReader return null → throws → caller gets 409.
    const storedVerdictId = 'nowhere-bundle';

    const mockMainReader = {
      listBundleEntries() {
        return [];
      },
      readFile() {
        return null; // not found on origin/main either
      },
    };

    const { designGateSourceEquivalenceCheck } = await import(
      '../../dist/infrastructure/harness-eval/design-gate/design-gate-replay-preflight.js'
    );

    await assert.rejects(
      () =>
        designGateSourceEquivalenceCheck(
          storedVerdictId,
          { kind: 'design-gate-episode-source-map', sourceMapId: 'any-map' },
          { harnessFeedbackRoot: root, mainReader: mockMainReader },
        ),
      /no source identity/,
      'must throw when source identity is unavailable from both live tree and mainReader',
    );
  });
});

/**
 * R4 — designGateReplayPreflight with FreshMainReader mock.
 *
 * When the live checkout is stale (bundles dir missing or incomplete), the
 * preflight must scan origin/main via ctx.mainReader to detect replays /
 * conflicts. These tests exercise that path with mock mainReader data.
 */
describe('designGateReplayPreflight — R4 origin/main scanning via mainReader', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = mkdtempSync(`${tmpdir()}/dg-preflight-r4-`);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('detects replay when bundle only exists on origin/main (stale live tree)', async () => {
    // R4: live tree has no matching bundles, but origin/main has one with the
    // same (domain, window, sourceMapId). Preflight must detect via mainReader.
    // R10: source-map YAML must also come from mainReader (canonical window).
    const sourceMapId = 'r4-stale-replay-map';
    const domainId = 'eval:design-gate';
    const storedVerdictId = 'origin-main-bundle-replay';

    // NO live-tree bundles dir — stale checkout

    // Mock mainReader: origin/main has both the source map and the bundle
    const mockMainReader = {
      listBundleEntries() {
        return [storedVerdictId];
      },
      readFile(relativePath) {
        // R10: source-map YAML from main (canonical window resolution)
        if (relativePath === `design-gate/source-maps/${sourceMapId}.yaml`) {
          return 'startMs: 7000\nendMs: 8000\n';
        }
        if (relativePath === `bundles/${storedVerdictId}/lifecycle-root.json`) {
          return JSON.stringify({ domainId });
        }
        if (relativePath === `bundles/${storedVerdictId}/snapshot.json`) {
          return JSON.stringify({ window: { startMs: 7000, endMs: 8000 } });
        }
        if (relativePath === `bundles/${storedVerdictId}/raw/episode-source-refs.json`) {
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

    assert.ok(result, 'preflight must detect the origin/main bundle');
    assert.equal(result.kind, 'replay');
    assert.equal(result.storedVerdictId, storedVerdictId);
  });

  it('detects conflict when origin/main bundle has different source identity', async () => {
    // R4: same (domain, window) on origin/main but different sourceMapId → conflict.
    // R10: source-map YAML must come from mainReader (canonical window).
    const incomingSourceMapId = 'r4-incoming-different-map';
    const storedSourceMapId = 'r4-stored-different-map';
    const domainId = 'eval:design-gate';
    const storedVerdictId = 'origin-main-conflict-bundle';

    const mockMainReader = {
      listBundleEntries() {
        return [storedVerdictId];
      },
      readFile(relativePath) {
        // R10: source-map YAML from main (canonical window resolution)
        if (relativePath === `design-gate/source-maps/${incomingSourceMapId}.yaml`) {
          return 'startMs: 9000\nendMs: 10000\n';
        }
        if (relativePath === `bundles/${storedVerdictId}/lifecycle-root.json`) {
          return JSON.stringify({ domainId });
        }
        if (relativePath === `bundles/${storedVerdictId}/snapshot.json`) {
          return JSON.stringify({ window: { startMs: 9000, endMs: 10000 } });
        }
        if (relativePath === `bundles/${storedVerdictId}/raw/episode-source-refs.json`) {
          return JSON.stringify({
            selector: { kind: 'design-gate-episode-source-map', sourceMapId: storedSourceMapId },
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

    assert.ok(result, 'preflight must detect the window collision');
    assert.equal(result.kind, 'conflict');
    assert.equal(result.storedVerdictId, storedVerdictId);
    assert.match(result.detail, /source differs/);
  });

  it('detects replay via mainReader when source map YAML is missing from live tree (R5 P1-2)', async () => {
    // R5 P1-2: live tree has NO source map YAML at all, but origin/main has both
    // the source map and the matching bundle. Preflight must fall back to mainReader
    // for source map resolution, then detect the replay on origin/main.
    const sourceMapId = 'r5-stale-live-source-map';
    const domainId = 'eval:design-gate';
    const storedVerdictId = 'r5-main-only-bundle';

    // DO NOT seed any source map YAML on the live tree — that's the point of this test.
    // The live bundles dir is also empty (stale checkout).

    const mockMainReader = {
      listBundleEntries() {
        return [storedVerdictId];
      },
      readFile(relativePath) {
        // Source map YAML — mainReader provides the window resolution
        if (relativePath === `design-gate/source-maps/${sourceMapId}.yaml`) {
          return 'startMs: 50000\nendMs: 60000\n';
        }
        if (relativePath === `bundles/${storedVerdictId}/lifecycle-root.json`) {
          return JSON.stringify({ domainId });
        }
        if (relativePath === `bundles/${storedVerdictId}/snapshot.json`) {
          return JSON.stringify({ window: { startMs: 50000, endMs: 60000 } });
        }
        if (relativePath === `bundles/${storedVerdictId}/raw/episode-source-refs.json`) {
          return JSON.stringify({
            selector: { kind: 'design-gate-episode-source-map', sourceMapId },
          });
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

    assert.ok(result, 'preflight must detect the origin/main bundle via mainReader source map fallback');
    assert.equal(result.kind, 'replay', 'same sourceMapId on origin/main must be detected as replay');
    assert.equal(result.storedVerdictId, storedVerdictId);
  });
});
