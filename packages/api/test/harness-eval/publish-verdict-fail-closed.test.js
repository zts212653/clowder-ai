import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket } from './publish-verdict-fixtures.js';

/**
 * R9–R10 — Canonical proof failure must not fall back to stale/live state.
 *
 * The same failure-mode family as R5→R8: null ambiguity in canonical
 * resolution causes fallback to less-authoritative state.
 *
 * R9 gaps:
 *  - P1-1: main has bundle but source-refs absent/unreadable → must fail
 *    closed, not fall back to live tree.
 *  - P1-2: post-collision fresh reader factory returns undefined (fetch
 *    failure) → must fail closed, not reuse stale pre-publish reader.
 *
 * R10 gaps (same family):
 *  - P1-1: verdict-only canonical artifact (no lifecycle) + matching live
 *    source → must fail closed, not bypass into live-based equivalence.
 *  - P1-2: main source-map unavailable + live YAML window + matching main
 *    bundle → preflight must not produce typed success.
 *  - P1-3: late verdict_already_exists_on_main catch + verdict-only on
 *    refreshed reader → equivalence checker must not fall to live.
 */
describe('handlePublishVerdict — R9 fail-closed on canonical proof failure', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = setupHarnessFeedback();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns 409 when canonical main has bundle but source identity is absent — NOT live fallback (R9-1)', async () => {
    // R9 P1-1: designGateSourceEquivalenceCheck reads source-refs from main.
    // mainReader.readFile() returns null for both "absent" and "git show error".
    // When main HAS the bundle (lifecycle-root.json exists) but source-refs
    // returns null, the old code falls through to live tree. A matching stale
    // live identity turns canonical proof failure into no_new_window.
    const existingId = 'r9-main-incomplete-bundle';

    // Seed live-tree bundle with matching sourceMapId
    const liveBundlePath = resolve(root, 'bundles', existingId);
    mkdirSync(resolve(liveBundlePath, 'raw'), { recursive: true });
    writeFileSync(resolve(liveBundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId: 'eval:design-gate' }));
    writeFileSync(
      resolve(liveBundlePath, 'raw', 'episode-source-refs.json'),
      JSON.stringify({ selector: { kind: 'design-gate-episode-source-map', sourceMapId: 'matching-source' } }),
    );

    // Mock mainReader: bundle exists (lifecycle-root.json present) but source-refs is ABSENT
    const mainReaderWithIncompletBundle = {
      listBundleEntries() {
        return [existingId];
      },
      readFile(relativePath) {
        if (relativePath === `bundles/${existingId}/lifecycle-root.json`) {
          return JSON.stringify({ domainId: 'eval:design-gate' });
        }
        if (relativePath === `verdicts/${existingId}.md`) return '---\n---\n';
        // source-refs deliberately absent → returns null (simulates missing or git show error)
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
        mainReader: mainReaderWithIncompletBundle,
        createFreshMainReader: () => mainReaderWithIncompletBundle,
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
        // Incoming matches live (matching-source) — the bug: stale live would grant success
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId: 'matching-source' },
      },
    );

    // R9: main has the bundle but can't read source identity → fail closed (409)
    // Must NOT return no_new_window by falling through to live tree
    assert.ok('error' in result, `expected 409 error (fail closed), got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 409);
  });

  it('returns 409 when verdict-only canonical artifact + matching live source — NOT no_new_window (R10-1)', async () => {
    // R10 P1-1: resolvePacketIdWithSourceVerification uses mainHasVerdict || mainHasBundle.
    // If main has the verdict file but NOT lifecycle-root.json (incomplete/orphan),
    // the code USED to enter verifySourceIdentity → equivalence checker checked
    // lifecycle only → fell to live → matching live source → no_new_window.
    // R10 fix: verdict-only canonical artifact fails closed before reaching checker.
    const existingId = 'r10-verdict-only-orphan';

    // Seed live-tree bundle with matching source
    const liveBundlePath = resolve(root, 'bundles', existingId);
    mkdirSync(resolve(liveBundlePath, 'raw'), { recursive: true });
    writeFileSync(resolve(liveBundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId: 'eval:design-gate' }));
    writeFileSync(
      resolve(liveBundlePath, 'raw', 'episode-source-refs.json'),
      JSON.stringify({ selector: { kind: 'design-gate-episode-source-map', sourceMapId: 'matching-orphan' } }),
    );

    // Mock mainReader: verdict exists but NO lifecycle-root.json (incomplete bundle)
    const verdictOnlyReader = {
      listBundleEntries() {
        return [];
      },
      readFile(relativePath) {
        if (relativePath === `verdicts/${existingId}.md`) return '---\n---\n';
        // No lifecycle-root.json, no source-refs — orphan verdict
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
        mainReader: verdictOnlyReader,
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
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId: 'matching-orphan' },
      },
    );

    // R10: verdict-only on main = incomplete canonical artifact → fail closed (409)
    assert.ok('error' in result, `expected 409 (fail closed), got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 409);
  });

  it('returns 409 when late verdict_already_exists catch + verdict-only on fresh reader — NOT live fallback (R10-3)', async () => {
    // R10 P1-3: post-collision catch for verdict_already_exists_on_main calls
    // designGateSourceEquivalenceCheck with the fresh reader. If fresh reader
    // shows verdict but no lifecycle, old code falls to live → matching source
    // → no_new_window. R10 fix: checker sees verdict OR lifecycle as canonical
    // presence → source MUST come from main → no source refs → throw → 409.
    const existingId = 'r10-catch-verdict-only';

    // Seed live-tree bundle with matching source
    const liveBundlePath = resolve(root, 'bundles', existingId);
    mkdirSync(resolve(liveBundlePath, 'raw'), { recursive: true });
    writeFileSync(resolve(liveBundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId: 'eval:design-gate' }));
    writeFileSync(
      resolve(liveBundlePath, 'raw', 'episode-source-refs.json'),
      JSON.stringify({ selector: { kind: 'design-gate-episode-source-map', sourceMapId: 'catch-match' } }),
    );

    // Fresh reader after collision: verdict exists but no lifecycle (orphan on main)
    const verdictOnlyFreshReader = {
      listBundleEntries() {
        return [];
      },
      readFile(relativePath) {
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
        mainReader: { listBundleEntries: () => [], readFile: () => null },
        createFreshMainReader: () => verdictOnlyFreshReader,
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
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId: 'catch-match' },
      },
    );

    // R10: catch path + verdict-only fresh reader → checker throws → 409
    assert.ok('error' in result, `expected 409 (fail closed), got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 409);
  });

  it('returns 409 when post-collision fresh reader factory fails — NOT stale pre-publish reader (R9-2)', async () => {
    // R9 P1-2: resolvePostPublishCollision uses
    // `ctx.createFreshMainReader?.() ?? ctx.mainReader`. When factory EXISTS
    // but returns undefined (e.g., git fetch failure), ?? silently falls back
    // to the stale pre-publish mainReader. The equivalence check on the stale
    // reader finds no bundle on main → falls to live tree → live matches →
    // no_new_window. The fix: factory failure = fail closed, not stale fallback.
    const existingId = 'r9-factory-failure';

    // Seed live-tree bundle with matching sourceMapId — if code falls to live,
    // this match would incorrectly produce no_new_window
    const liveBundlePath = resolve(root, 'bundles', existingId);
    mkdirSync(resolve(liveBundlePath, 'raw'), { recursive: true });
    writeFileSync(resolve(liveBundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId: 'eval:design-gate' }));
    writeFileSync(
      resolve(liveBundlePath, 'raw', 'episode-source-refs.json'),
      JSON.stringify({ selector: { kind: 'design-gate-episode-source-map', sourceMapId: 'factory-fail-source' } }),
    );

    // Pre-publish mainReader: EMPTY — packet not yet on main at pre-publish time.
    // Pre-publish check will return 'proceed', publisher will run.
    const emptyStaleReader = {
      listBundleEntries() {
        return [];
      },
      readFile() {
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
        mainReader: emptyStaleReader,
        // Factory EXISTS but returns undefined — simulates git fetch failure.
        // The bug: ?? falls back to emptyStaleReader → equivalence check falls
        // to live tree → live matches → no_new_window.
        createFreshMainReader: () => undefined,
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
        // Incoming matches live tree source — the bug path
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId: 'factory-fail-source' },
      },
    );

    // R9: factory exists but failed → fail closed (409)
    // Must NOT return no_new_window via stale reader fallback to live tree
    assert.ok('error' in result, `expected 409 error (fail closed), got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 409);
  });

  // R11 collision-proven reader guard tests in publish-verdict-collision-guard.test.js
});
