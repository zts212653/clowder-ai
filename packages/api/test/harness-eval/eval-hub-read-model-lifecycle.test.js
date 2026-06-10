import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';

/**
 * F192 Phase H 收尾 PR-3 R1 (砚砚 P1): split from eval-hub-read-model.test.js
 * to keep both files under AGENTS.md 350-line hard limit (parent file pre-existing
 * 629 lines; PR-3 modified 3 stale-lifecycle tests + must split touched coverage
 * per 砚砚 R1 lockpoint).
 *
 * Contents: lifecycle.stale calculation regression guards.
 */

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));
const FIXTURE_NOW_AFTER_DEADLINE = new Date('2026-05-29T00:00:00.000Z');

function writeA2aLiveVerdict(harnessFeedbackRoot, { verdictId, nextEvalAt, generatedAt }) {
  const verdictsDir = join(harnessFeedbackRoot, 'verdicts');
  const bundleDir = join(harnessFeedbackRoot, 'bundles', verdictId);
  mkdirSync(verdictsDir, { recursive: true });
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(
    join(verdictsDir, `${verdictId}.md`),
    `---
feedback_type: live-verdict
domain_id: eval:a2a
packet_id: vhp_${verdictId.replace(/-/g, '_')}
---

# Live Verdict — ${verdictId}

- Verdict: \`keep_observe\`
- Phenomenon: No actionable A2A findings: clean
- Harness: F167/C1 (hold_ball (MCP tool))
- Owner ask: No action required; keep observing.
- Re-eval: next eval at ${nextEvalAt}

Evidence:
- snapshot:bundle/${verdictId}/snapshot
- attribution:bundle/${verdictId}/eval-F167-${verdictId}:no-finding
- metric:c1.zombie_hold_count
`,
  );
  writeJson(join(bundleDir, 'snapshot.json'), {
    verdictId,
    evalSnapshotId: `eval-F167-${verdictId}`,
    featureId: 'F167',
    generatedAt,
    window: { durationHours: 24 },
    components: [
      {
        id: 'C1',
        name: 'hold_ball (MCP tool)',
        activationCounts: { hold_count: 1 },
        frictionCounts: { 'c1.zombie_hold_count': 0 },
        confidence: 'medium',
      },
    ],
  });
  writeJson(join(bundleDir, 'attribution.json'), {
    verdictId,
    featureId: 'F167',
    evalSnapshotId: `eval-F167-${verdictId}`,
    generatedAt,
    findings: [],
    noFindingRecord: { reason: 'clean', evidence: 'within threshold' },
  });
  writeJson(join(bundleDir, 'provenance.json'), {
    verdictId,
    generatedAt,
    rawInputs: [{ path: 'raw.yaml', sha256: 'a'.repeat(64) }],
    generator: { name: 'test', version: '1' },
    sanitizeRulesVersion: 'v1',
  });
}

function setupA2aOnlyHarnessFeedbackRoot(label) {
  const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), `f192-eval-hub-${label}-`));
  const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
  mkdirSync(domainsDir, { recursive: true });
  const a2aYaml = readFileSync(join(repoHarnessFeedbackRoot, 'eval-domains', 'eval-a2a.yaml'), 'utf8');
  writeFileSync(join(domainsDir, 'eval-a2a.yaml'), a2aYaml);
  return harnessFeedbackRoot;
}

describe('Eval Hub read model — lifecycle.stale', () => {
  // PR-3 (F192 H 收尾): SKIP — #2114 merge added 2nd eval:a2a verdict (newer,
  // not stale at FIXTURE_NOW_AFTER_DEADLINE). Supersede rule legitimately flips
  // older fixture's lifecycle.stale to false. Per-item stale logic still covered
  // by supersede tests below. TODO: rebuild with isolated temp fixture dir.
  it.skip('marks lifecycle.stale = true and counts.stale = 1 when now is past nextEvalAt', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: FIXTURE_NOW_AFTER_DEADLINE,
    });
    assert.ok(summary.items.length >= 1);
    const item = summary.items.find((v) => v.id === '2026-05-23-eval-a2a-live-verdict');
    assert.ok(item);
    assert.equal(item.lifecycle.stale, true);
    assert.equal(item.verdict, 'keep_observe');
    assert.equal(item.lifecycle.closureStatus, 'observing');
    assert.equal(item.lifecycle.ownerResponseStatus, 'not_required');
  });

  // F192 P2 — boundary: at-deadline must not flip to stale (strict `>`, not `>=`)
  it('keeps lifecycle.stale = false when now equals nextEvalAt exactly', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: new Date('2026-05-26T03:12:57.174Z'),
    });
    // PR-3 R3 (cloud R5 P2): #2114 accumulation means items[0] is now the newer
    // 2026-06-06 verdict, not the 2026-05-23 fixture whose nextEvalAt matches `now`.
    // Find fixture explicitly by id to preserve at-deadline boundary regression intent.
    const fixture = summary.items.find((v) => v.id === '2026-05-23-eval-a2a-live-verdict');
    assert.ok(fixture, 'fixture verdict must remain in summary');
    assert.equal(fixture.lifecycle.stale, false, 'at-deadline tick is not yet stale');
    assert.equal(summary.counts.stale, 0);
  });

  // F192 P2 — defensive: missing nextEvalAt cannot imply staleness
  it('returns lifecycle.stale = false when the Re-eval bullet lacks an ISO timestamp', () => {
    const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), 'f192-eval-hub-no-deadline-'));
    const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
    const verdictsDir = join(harnessFeedbackRoot, 'verdicts');
    mkdirSync(domainsDir, { recursive: true });
    mkdirSync(verdictsDir, { recursive: true });
    const a2aYaml = readFileSync(join(repoHarnessFeedbackRoot, 'eval-domains', 'eval-a2a.yaml'), 'utf8');
    writeFileSync(join(domainsDir, 'eval-a2a.yaml'), a2aYaml);
    const verdictId = '2026-05-24-eval-a2a-no-deadline';
    const bundleDir = join(harnessFeedbackRoot, 'bundles', verdictId);
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(verdictsDir, `${verdictId}.md`),
      `---
feedback_type: live-verdict
domain_id: eval:a2a
packet_id: vhp_no_deadline
---

# Live Verdict — ${verdictId}

- Verdict: \`keep_observe\`
- Phenomenon: No actionable A2A findings: clean
- Harness: F167/C1 (hold_ball (MCP tool))
- Owner ask: No action required; keep observing.
- Re-eval: window pending; date to be assigned upstream

Evidence:
- snapshot:bundle/${verdictId}/snapshot
- attribution:bundle/${verdictId}/eval-F167-2026-05-24:no-finding
- metric:c1.zombie_hold_count
`,
    );
    writeJson(join(bundleDir, 'snapshot.json'), {
      verdictId,
      evalSnapshotId: 'eval-F167-2026-05-24',
      featureId: 'F167',
      generatedAt: '2026-05-24T12:00:00.000Z',
      window: { durationHours: 24 },
      components: [
        {
          id: 'C1',
          name: 'hold_ball (MCP tool)',
          activationCounts: { hold_count: 1 },
          frictionCounts: { 'c1.zombie_hold_count': 0 },
          confidence: 'medium',
        },
      ],
    });
    writeJson(join(bundleDir, 'attribution.json'), {
      verdictId,
      featureId: 'F167',
      evalSnapshotId: 'eval-F167-2026-05-24',
      generatedAt: '2026-05-24T12:01:00.000Z',
      findings: [],
      noFindingRecord: { reason: 'clean', evidence: 'within threshold' },
    });
    writeJson(join(bundleDir, 'provenance.json'), {
      verdictId,
      generatedAt: '2026-05-24T12:02:00.000Z',
      rawInputs: [{ path: 'raw.yaml', sha256: 'b'.repeat(64) }],
      generator: { name: 'test', version: '1' },
      sanitizeRulesVersion: 'v1',
    });
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot,
      now: new Date('2099-01-01T00:00:00.000Z'),
    });
    assert.equal(summary.items.length, 1);
    assert.equal(summary.items[0].reeval.nextEvalAt, undefined);
    assert.equal(summary.items[0].lifecycle.stale, false);
    assert.equal(summary.counts.stale, 0);
  });

  // F192 P2 — PR 791 review regression guard. Supersede rule on lifecycle.stale.
  it('does not count an older overdue verdict as stale when a newer fresh verdict supersedes it (same domain)', () => {
    const harnessFeedbackRoot = setupA2aOnlyHarnessFeedbackRoot('supersede-fresh');
    writeA2aLiveVerdict(harnessFeedbackRoot, {
      verdictId: '2026-05-20-eval-a2a-older',
      nextEvalAt: '2026-05-23T00:00:00.000Z',
      generatedAt: '2026-05-20T00:00:00.000Z',
    });
    writeA2aLiveVerdict(harnessFeedbackRoot, {
      verdictId: '2026-05-26-eval-a2a-newer',
      nextEvalAt: '2026-05-30T00:00:00.000Z',
      generatedAt: '2026-05-26T00:00:00.000Z',
    });
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot,
      now: new Date('2026-05-27T00:00:00.000Z'),
    });
    assert.equal(summary.items.length, 2);
    assert.equal(summary.items[0].id, '2026-05-26-eval-a2a-newer');
    assert.equal(summary.items[1].id, '2026-05-20-eval-a2a-older');
    assert.equal(summary.counts.stale, 0);
    assert.equal(summary.items[0].lifecycle.stale, false);
    assert.equal(summary.items[1].lifecycle.stale, false);
    const a2aDomain = summary.domains.find((d) => d.domainId === 'eval:a2a');
    assert.equal(a2aDomain.latestVerdictId, '2026-05-26-eval-a2a-newer');
  });

  // F192 P2 — PR 791 review regression guard (companion case). Latest-only counting.
  it('counts only the latest overdue verdict as stale per domain (not every historical overdue)', () => {
    const harnessFeedbackRoot = setupA2aOnlyHarnessFeedbackRoot('supersede-both-overdue');
    writeA2aLiveVerdict(harnessFeedbackRoot, {
      verdictId: '2026-05-15-eval-a2a-older-overdue',
      nextEvalAt: '2026-05-18T00:00:00.000Z',
      generatedAt: '2026-05-15T00:00:00.000Z',
    });
    writeA2aLiveVerdict(harnessFeedbackRoot, {
      verdictId: '2026-05-22-eval-a2a-newer-overdue',
      nextEvalAt: '2026-05-25T00:00:00.000Z',
      generatedAt: '2026-05-22T00:00:00.000Z',
    });
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot,
      now: new Date('2026-05-29T00:00:00.000Z'),
    });
    assert.equal(summary.items.length, 2);
    assert.equal(summary.counts.stale, 1);
    const latest = summary.items.find((i) => i.id === '2026-05-22-eval-a2a-newer-overdue');
    const older = summary.items.find((i) => i.id === '2026-05-15-eval-a2a-older-overdue');
    assert.equal(latest.lifecycle.stale, true);
    assert.equal(older.lifecycle.stale, false);
  });
});
