import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveA2aEvidenceBundle } from '../../dist/infrastructure/harness-eval/a2a/eval-a2a-artifact-resolver.js';
import { createHarnessLedgerGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/harness-ledger-generator-adapter.js';

// ---------------------------------------------------------------------------
// F257 V2/Phase B — per-finding attribution refs (producer side).
//
// PR #43 (merged fork/main) fixed HISTORICAL bundle assets whose verdict md
// referenced a bare `attribution:bundle/<id>/<evalSnapshotId>` — a ref the
// resolver cannot map to any bundled finding. V2 fixes the PRODUCER so the
// generator never emits that shape again (sol ruling msg 0001784470377310,
// terra independent concurrence; merged criteria msg 0001784470473525):
//   1. each findings[].id gets its own attribution ref
//   2. multi-guard bundles reference each `f257-guard-<guardId>` finding
//   3. every ref independently resolvable
//   4. `<evalSnapshotId>:no-finding` anchor legal ONLY when findings=[] with
//      noFindingRecord
//   5. regression: ALL refs in the committed bundle resolve
//
// Resolution authority: resolveA2aEvidenceBundle (fail-closed bundle gate) —
// these tests feed the md-declared refs back through the resolver, so
// "resolvable" is asserted by the production gate itself, not a re-encoding.
// ---------------------------------------------------------------------------

const T = 1700000000000;

function makeStoredSnapshot({ evalRunId, windowStartMs, windowEndMs, byGuard, byKind, totalEvents }) {
  return {
    evalRunId,
    producedAt: new Date(T).toISOString(),
    ownerUserId: 'user_1',
    window: { startMs: windowStartMs, endMs: windowEndMs, durationHours: 168 },
    totalEvents,
    byKind,
    byGuard,
    sampleAnchors:
      totalEvents > 0
        ? [{ eventId: 'evt-1', kind: 'http_rate_limit', guardId: 'hold_ball_rate_limit', timestamp: T }]
        : [],
    howCounted: 'zset-window-scan',
  };
}

function guardAgg(count, kinds, episodeCount, episodes = []) {
  return { count, kinds, episodeCount, episodes };
}

async function generateBundle(storedSnapshot, packetId) {
  const root = mkdtempSync(join(tmpdir(), 'f257-attr-refs-'));
  mkdirSync(join(root, 'run-snapshots'), { recursive: true });
  writeFileSync(join(root, 'run-snapshots', `${storedSnapshot.evalRunId}.json`), JSON.stringify(storedSnapshot));

  const generate = createHarnessLedgerGeneratorAdapter();
  const { verdictPath, bundleDir } = await generate(
    { id: packetId, verdict: 'fix' },
    {
      kind: 'prompt-segments',
      windowStartMs: storedSnapshot.window.startMs,
      windowEndMs: storedSnapshot.window.endMs,
      evalRunId: storedSnapshot.evalRunId,
    },
    { harnessFeedbackRoot: root, liveHarnessFeedbackRoot: root, ownerUserId: 'user_1' },
  );
  const verdictMd = readFileSync(verdictPath, 'utf8');
  return { root, bundleDir, verdictMd };
}

/** Extract `- attribution:bundle/...` evidence lines from the verdict markdown. */
function extractAttributionRefs(verdictMd) {
  return verdictMd
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- attribution:bundle/'))
    .map((line) => line.slice(2));
}

describe('generator adapter — per-finding attribution refs (producer fix)', () => {
  it('multi-guard bundle: verdict md declares one resolvable ref per finding, never a bare evalSnapshotId ref', async () => {
    const packetId = 'test-attr-multi-1';
    const stored = makeStoredSnapshot({
      evalRunId: 'hlr-1700000000000-aaaa1111',
      windowStartMs: T - 1000,
      windowEndMs: T + 100_000,
      totalEvents: 5,
      byKind: { http_rate_limit: 4, route_decision_block: 1 },
      byGuard: {
        hold_ball_rate_limit: guardAgg(4, ['http_rate_limit'], 1),
        a2a_block_pingpong: guardAgg(1, ['route_decision_block'], 1),
      },
    });

    const { bundleDir, verdictMd } = await generateBundle(stored, packetId);
    const mdRefs = extractAttributionRefs(verdictMd);

    // Criterion 1+2: one ref per finding, referencing each f257-guard-<guardId>.
    assert.equal(mdRefs.length, 2, 'verdict md must declare one attribution ref per finding');
    assert.ok(
      mdRefs.includes(`attribution:bundle/${packetId}/f257-guard-hold_ball_rate_limit`),
      'hold_ball finding ref declared',
    );
    assert.ok(
      mdRefs.includes(`attribution:bundle/${packetId}/f257-guard-a2a_block_pingpong`),
      'a2a finding ref declared',
    );

    // The bare evalSnapshotId shape must be gone (PR #43 root cause).
    assert.ok(
      !mdRefs.some((r) => r.includes('harness-ledger-snapshot-') && !r.endsWith(':no-finding')),
      'bare evalSnapshotId attribution ref must not be produced when findings exist',
    );

    // Criterion 3+5: feed the md-declared refs through the production resolver —
    // every declared ref must resolve against the committed bundle.
    const resolved = resolveA2aEvidenceBundle({
      bundleDir,
      verdictId: packetId,
      attributionRefs: mdRefs,
    });
    assert.equal(resolved.attributionRefs.length, 2, 'resolver derives the same two per-finding refs');
    assert.deepEqual(new Set(resolved.attributionRefs), new Set(mdRefs), 'md refs and resolver refs are the same set');
  });

  it('zero-event bundle: no-finding anchor is declared and resolves (criterion 4)', async () => {
    const packetId = 'test-attr-zero-1';
    const stored = makeStoredSnapshot({
      evalRunId: 'hlr-1700000000000-bbbb2222',
      windowStartMs: T - 1000,
      windowEndMs: T + 100_000,
      totalEvents: 0,
      byKind: {},
      byGuard: {},
    });

    const { bundleDir, verdictMd } = await generateBundle(stored, packetId);
    const mdRefs = extractAttributionRefs(verdictMd);

    assert.equal(mdRefs.length, 1, 'zero-event verdict declares exactly the no-finding ref');
    assert.ok(mdRefs[0].endsWith(':no-finding'), 'no-finding anchor shape');

    const resolved = resolveA2aEvidenceBundle({
      bundleDir,
      verdictId: packetId,
      attributionRefs: mdRefs,
    });
    assert.equal(resolved.attributionRefs.length, 1);
    assert.ok(resolved.attributionRefs[0].endsWith(':no-finding'));
    assert.ok(resolved.attributionReport.noFindingRecord, 'noFindingRecord present when findings=[]');
  });

  it('bundle attribution findings carry episode accounting fields (provenance criteria join)', async () => {
    const packetId = 'test-attr-episode-1';
    const stored = makeStoredSnapshot({
      evalRunId: 'hlr-1700000000000-cccc3333',
      windowStartMs: T - 1000,
      windowEndMs: T + 100_000,
      totalEvents: 4,
      byKind: { http_rate_limit: 4 },
      byGuard: { hold_ball_rate_limit: guardAgg(4, ['http_rate_limit'], 1) },
    });

    const { bundleDir } = await generateBundle(stored, packetId);
    const attribution = JSON.parse(readFileSync(join(bundleDir, 'attribution.json'), 'utf8'));
    assert.equal(attribution.findings.length, 1);
    assert.equal(attribution.findings[0].id, 'f257-guard-hold_ball_rate_limit');
    assert.equal(attribution.findings[0].rawEventCount, 4, 'finding carries rawEventCount');
    assert.equal(attribution.findings[0].episodeCount, 1, 'finding carries episodeCount (distinct incidents)');
  });
});
