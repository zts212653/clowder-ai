import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket, seedCanonicalMeasurementCensusState } from './publish-verdict-fixtures.js';

/**
 * R11 — Post-collision canonical presence guard.
 *
 * Publisher collision proves origin/main has the verdict. If a successfully
 * created fresh reader cannot see any canonical artifact (verdict file or
 * lifecycle-root.json), the reader is unreliable — must fail closed (409),
 * not let the equivalence checker fall through to live source identity.
 *
 * Covers both collision codes: verdict_already_exists_on_main (packet-ID)
 * and verdict_window_already_published (window collision).
 */

/** Seed live-tree design-gate bundle with source refs for a given verdict ID. */
function seedLiveSourceRefs(root, verdictId, sourceMapId) {
  const bundlePath = resolve(root, 'bundles', verdictId);
  mkdirSync(resolve(bundlePath, 'raw'), { recursive: true });
  writeFileSync(resolve(bundlePath, 'lifecycle-root.json'), JSON.stringify({ domainId: 'eval:design-gate' }));
  writeFileSync(
    resolve(bundlePath, 'raw', 'episode-source-refs.json'),
    JSON.stringify({ selector: { kind: 'design-gate-episode-source-map', sourceMapId } }),
  );
}

describe('handlePublishVerdict — R11 collision-proven reader guard', () => {
  /** @type {string} */
  let root;
  /** @type {Function} */
  let designGateSourceEquivalenceCheck;

  before(async () => {
    root = setupHarnessFeedback();
    ({ designGateSourceEquivalenceCheck } = await import(
      '../../dist/infrastructure/harness-eval/design-gate/design-gate-replay-preflight.js'
    ));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns 409 when verdict_already_exists_on_main + fresh reader reads all null + matching live source (R11-1)', async () => {
    const existingId = 'r11-collision-blind-reader';
    seedLiveSourceRefs(root, existingId, 'r11-blind-src');

    // Fresh reader successfully created but all reads return null (git show failure / corrupt refs)
    const blindReader = { listBundleEntries: () => [], readFile: () => null };

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        checkStoredSourceEquivalence: designGateSourceEquivalenceCheck,
        mainReader: blindReader,
        createFreshMainReader: () => blindReader,
        gitPublisher: {
          async publishOnIsolatedWorktree() {
            throw new Error(`verdict_already_exists_on_main: packet.id '${existingId}' already exists on origin/main.`);
          },
        },
        generator: async (packet, _sr, deps) => {
          const bd = `${deps.harnessFeedbackRoot}/bundles/${packet.id}`;
          mkdirSync(bd, { recursive: true });
          return { verdictPath: `${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`, bundleDir: bd };
        },
      },
      {
        packet: buildPacket({ id: existingId, domainId: 'eval:design-gate' }),
        domain: 'eval:design-gate',
        catId: 'opus',
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId: 'r11-blind-src' },
      },
    );

    // Collision proves main has it; blind reader can't establish canonical identity → 409
    assert.ok('error' in result, `expected 409 (collision-proven but reader blind), got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 409);
  });

  it('returns 409 when verdict_window_already_published + fresh reader reads all null + matching live source (R11-2)', async () => {
    const winnerId = 'r11-window-blind-reader';
    seedLiveSourceRefs(root, winnerId, 'r11-window-src');

    const blindReader = { listBundleEntries: () => [], readFile: () => null };

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: root,
        checkStoredSourceEquivalence: designGateSourceEquivalenceCheck,
        mainReader: blindReader,
        createFreshMainReader: () => blindReader,
        gitPublisher: {
          async publishOnIsolatedWorktree(opts) {
            const fakeWorktree = mkdtempSync(`${tmpdir()}/r11-window-`);
            seedCanonicalMeasurementCensusState(fakeWorktree);
            await opts.stage(fakeWorktree);
            throw new Error(`verdict_window_already_published: r11-new conflicts with existing verdict ${winnerId}`);
          },
        },
        generator: async (packet, _sr, deps) => {
          const bd = `${deps.harnessFeedbackRoot}/bundles/${packet.id}`;
          mkdirSync(bd, { recursive: true });
          const vp = `${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`;
          writeFileSync(vp, `---\ndomain_id: eval:design-gate\n---\n`);
          return { verdictPath: vp, bundleDir: bd };
        },
      },
      {
        packet: buildPacket({ id: 'r11-new-window', domainId: 'eval:design-gate' }),
        domain: 'eval:design-gate',
        catId: 'opus',
        sourceRefs: { kind: 'design-gate-episode-source-map', sourceMapId: 'r11-window-src' },
      },
    );

    // Window collision proves main has a winner; blind reader → 409
    assert.ok('error' in result, `expected 409 (window collision + reader blind), got: ${JSON.stringify(result)}`);
    assert.equal(result.status, 409);
  });
});
