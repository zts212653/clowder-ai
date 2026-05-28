import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseSanitizedIssuePacket,
  sanitizeVerdictForExport,
} from '../../dist/infrastructure/harness-eval/community-issue-packet.js';
import { parseVerdictHandoffPacket } from '../../dist/infrastructure/harness-eval/verdict-handoff.js';

/** Minimal valid VerdictHandoffPacket for testing sanitization. */
function makeVerdict(overrides = {}) {
  return {
    id: 'verdict-001',
    domainId: 'eval:a2a',
    createdAt: '2026-05-27T03:00:00+08:00',
    phenomenon: 'A2A ball drop rate exceeds baseline by 15%',
    harnessUnderEval: {
      featureId: 'F167',
      componentId: 'l1-ping-pong-breaker',
      name: 'L1 Ping-Pong Breaker',
    },
    evidencePacket: {
      snapshotRefs: ['snapshot-2026-05-26', 'snapshot-2026-05-27'],
      attributionRefs: ['attr-001'],
      metricRefs: ['metric-activation', 'metric-friction'],
      sampleTraceRefs: ['trace-abc123'],
    },
    dailyTrend: {
      window: '7d',
      current: { ball_drop_rate: 0.18 },
      baseline: { ball_drop_rate: 0.03 },
      threshold: { ball_drop_rate: 0.1 },
      direction: 'regressed',
    },
    rootCauseHypothesis: {
      summary: 'Route-serial guard fires before ack timeout, causing premature ball drops',
      confidence: 'medium',
      alternatives: ['Increased parallel sessions diluting cat attention'],
    },
    verdict: 'fix',
    ownerAsk: {
      targetFeatureId: 'F167',
      targetOwnerCatId: 'opus47',
      requestedAction: 'Increase ack timeout from 30s to 60s in route-serial guard',
    },
    acceptanceReevalPlan: {
      nextEvalAt: '2026-06-03T03:00:00+08:00',
      closureCondition: 'ball_drop_rate < 0.10 for 3 consecutive days',
    },
    counterarguments: ['Timeout increase may mask genuine unresponsive sessions'],
    ...overrides,
  };
}

describe('SanitizedIssuePacket', () => {
  describe('parseSanitizedIssuePacket', () => {
    it('accepts a valid sanitized issue packet', () => {
      const packet = {
        id: 'sip-001',
        domainId: 'eval:code-review',
        exportedAt: '2026-05-27T10:00:00+08:00',
        sourceInstanceId: 'community-alpha',
        phenomenon: 'Review pass-through rate exceeds 90%',
        harnessComponent: {
          componentId: 'review-gate-v1',
          name: 'Review Gate',
        },
        evidenceSummary: {
          snapshotCount: 3,
          attributionCount: 1,
          metricCount: 2,
          traceCount: 5,
        },
        dailyTrend: {
          window: '7d',
          current: { passthrough_rate: 0.92 },
          baseline: { passthrough_rate: 0.75 },
          threshold: { passthrough_rate: 0.85 },
          direction: 'regressed',
        },
        rootCauseHypothesis: {
          summary: 'Reviewer workload spike reduced review depth',
          confidence: 'medium',
          alternatives: ['Criteria too vague'],
        },
        verdict: 'fix',
        requestedAction: 'Tighten review gate criteria',
        counterarguments: ['High pass rate may reflect improved code quality'],
      };
      const parsed = parseSanitizedIssuePacket(packet);
      assert.equal(parsed.id, 'sip-001');
      assert.equal(parsed.domainId, 'eval:code-review');
    });

    it('rejects packet missing required fields', () => {
      assert.throws(() => parseSanitizedIssuePacket({ id: 'bad' }), /domainId|exportedAt|phenomenon/i);
    });

    it('accepts any eval: domain prefix (not restricted to internal enum)', () => {
      const packet = {
        id: 'sip-002',
        domainId: 'eval:my-custom-domain',
        exportedAt: '2026-05-27T10:00:00+08:00',
        sourceInstanceId: 'community-beta',
        phenomenon: 'Custom domain finding',
        harnessComponent: { componentId: 'custom-v1', name: 'Custom' },
        evidenceSummary: { snapshotCount: 1, attributionCount: 1, metricCount: 1, traceCount: 1 },
        dailyTrend: {
          window: '7d',
          current: { x: 1 },
          baseline: { x: 0 },
          threshold: { x: 0.5 },
          direction: 'regressed',
        },
        rootCauseHypothesis: { summary: 'test', confidence: 'low', alternatives: ['alt'] },
        verdict: 'keep_observe',
        requestedAction: 'Observe',
        counterarguments: ['Insufficient data'],
      };
      const parsed = parseSanitizedIssuePacket(packet);
      assert.equal(parsed.domainId, 'eval:my-custom-domain');
    });
  });

  describe('sanitizeVerdictForExport', () => {
    it('strips internal featureId to opaque reference', () => {
      const verdict = parseVerdictHandoffPacket(makeVerdict());
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      // featureId should NOT appear in sanitized output
      assert.ok(!JSON.stringify(sanitized).includes('F167'));
    });

    it('replaces evidence refs with redacted counts', () => {
      const verdict = parseVerdictHandoffPacket(makeVerdict());
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      assert.equal(sanitized.evidenceSummary.snapshotCount, 2);
      assert.equal(sanitized.evidenceSummary.attributionCount, 1);
      assert.equal(sanitized.evidenceSummary.metricCount, 2);
      assert.equal(sanitized.evidenceSummary.traceCount, 1);
      // Original ref strings should not appear
      assert.ok(!JSON.stringify(sanitized).includes('snapshot-2026'));
      assert.ok(!JSON.stringify(sanitized).includes('trace-abc123'));
    });

    it('replaces ownerCatId with role label', () => {
      const verdict = parseVerdictHandoffPacket(makeVerdict());
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      assert.ok(!JSON.stringify(sanitized).includes('opus47'));
    });

    it('preserves phenomenon, verdict, trend, hypothesis, and counterarguments', () => {
      const verdict = parseVerdictHandoffPacket(makeVerdict());
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      assert.equal(sanitized.phenomenon, verdict.phenomenon);
      assert.equal(sanitized.verdict, verdict.verdict);
      assert.deepEqual(sanitized.dailyTrend, verdict.dailyTrend);
      assert.deepEqual(sanitized.rootCauseHypothesis, verdict.rootCauseHypothesis);
      assert.deepEqual(sanitized.counterarguments, verdict.counterarguments);
    });

    it('sets sourceInstanceId and exportedAt', () => {
      const verdict = parseVerdictHandoffPacket(makeVerdict());
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      assert.equal(sanitized.sourceInstanceId, 'my-instance');
      assert.ok(sanitized.exportedAt);
    });

    it('round-trip: sanitized output passes parseSanitizedIssuePacket', () => {
      const verdict = parseVerdictHandoffPacket(makeVerdict());
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      // Must pass schema validation
      const reparsed = parseSanitizedIssuePacket(sanitized);
      assert.equal(reparsed.id, sanitized.id);
    });

    // ---- P1 fixes: free-text scrubbing + opaque ID ----

    it('scrubs internal feature IDs (F\\d{3}) from free-text fields', () => {
      const verdict = parseVerdictHandoffPacket(
        makeVerdict({
          phenomenon: 'F167 ball drop rate exceeds baseline by 15%',
          rootCauseHypothesis: {
            summary: 'F167 route-serial guard fires too early',
            confidence: 'medium',
            alternatives: ['The F192 evaluation domain may need recalibration'],
          },
          ownerAsk: {
            targetFeatureId: 'F167',
            targetOwnerCatId: 'opus47',
            requestedAction: 'Fix F167 ack timeout in route-serial guard',
          },
          counterarguments: ['F167 module may need complete rework'],
        }),
      );
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      const json = JSON.stringify(sanitized);
      assert.ok(!/\bF\d{3}\b/.test(json), `sanitized output should not contain feature IDs, got: ${json}`);
    });

    it('scrubs internal thread IDs (thread_*) from free-text fields', () => {
      const verdict = parseVerdictHandoffPacket(
        makeVerdict({
          phenomenon: 'thread_eval_a2a shows anomalous ball drop pattern',
          ownerAsk: {
            targetFeatureId: 'F167',
            targetOwnerCatId: 'opus47',
            requestedAction: 'Check thread_eval_memory for corroborating data',
          },
        }),
      );
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      const json = JSON.stringify(sanitized);
      assert.ok(!/\bthread_[a-z0-9_]+\b/i.test(json), `sanitized output should not contain thread IDs, got: ${json}`);
    });

    it('scrubs evidence ref patterns from free-text fields', () => {
      const verdict = parseVerdictHandoffPacket(
        makeVerdict({
          counterarguments: ['See snapshot-2026-05-26 for context', 'trace-abc123 shows alternative path'],
        }),
      );
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      const json = JSON.stringify(sanitized);
      assert.ok(!json.includes('snapshot-2026'), 'should not contain snapshot refs in text');
      assert.ok(!json.includes('trace-abc123'), 'should not contain trace refs in text');
    });

    it('generates opaque ID not derived from internal verdict ID', () => {
      const verdict = parseVerdictHandoffPacket(makeVerdict());
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      // The internal ID is 'verdict-001' — sanitized ID must not contain it
      assert.ok(!sanitized.id.includes('verdict-001'), `ID should be opaque, got: ${sanitized.id}`);
      assert.ok(!sanitized.id.includes(verdict.id), `ID should not contain internal verdict ID`);
    });

    // ---- R2 P1-1: cat identity scrub + harnessComponent scrub ----

    it('scrubs ownerCatId from free-text fields', () => {
      const verdict = parseVerdictHandoffPacket(
        makeVerdict({
          phenomenon: 'opus47 reported anomalous ball drop pattern',
          rootCauseHypothesis: {
            summary: 'opus47 route-serial guard fires too early',
            confidence: 'medium',
            alternatives: ['opus47 may need configuration update'],
          },
          counterarguments: ['opus47 already tried increasing timeout'],
        }),
      );
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      const json = JSON.stringify(sanitized);
      assert.ok(!json.includes('opus47'), `should not contain cat identity, got: ${json}`);
    });

    it('scrubs internal identifiers from harnessComponent fields', () => {
      const verdict = parseVerdictHandoffPacket(
        makeVerdict({
          harnessUnderEval: {
            featureId: 'F167',
            componentId: 'F167-route-serial-breaker',
            name: 'F167 Route-Serial Breaker',
          },
        }),
      );
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      assert.ok(
        !/\bF\d{3}\b/.test(JSON.stringify(sanitized.harnessComponent)),
        'harnessComponent should not contain feature IDs',
      );
    });

    // ---- R2 P1-2: colon-format evidence refs ----

    it('scrubs colon-format evidence refs from free-text fields', () => {
      const verdict = parseVerdictHandoffPacket(
        makeVerdict({
          phenomenon: 'see snapshot:eval-2026-05-21 and trace:abc123 for context',
          counterarguments: ['metric:activation-rate shows improvement'],
        }),
      );
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      const json = JSON.stringify(sanitized);
      assert.ok(!json.includes('snapshot:eval'), 'should not contain colon-format snapshot refs');
      assert.ok(!json.includes('trace:abc123'), 'should not contain colon-format trace refs');
      assert.ok(!json.includes('metric:activation'), 'should not contain colon-format metric refs');
    });

    // ---- R3 P1-1: non-owner cat identity leak ----

    it('scrubs non-owner cat identities from free-text fields', () => {
      const verdict = parseVerdictHandoffPacket(
        makeVerdict({
          phenomenon: 'gpt52 flagged anomalous pattern while opus47 was investigating',
          rootCauseHypothesis: {
            summary: 'sonnet may have introduced the regression in a recent commit',
            confidence: 'medium',
            alternatives: ['codex review missed the edge case'],
          },
          counterarguments: ['gemini25 design review did not flag this'],
        }),
      );
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      const json = JSON.stringify(sanitized);
      assert.ok(!json.includes('gpt52'), 'should not contain non-owner cat identity gpt52');
      assert.ok(!json.includes('opus47'), 'should not contain owner cat identity opus47');
      assert.ok(!json.includes('sonnet'), 'should not contain cat identity sonnet');
      assert.ok(!json.includes('codex'), 'should not contain cat identity codex');
      assert.ok(!json.includes('gemini25'), 'should not contain cat identity gemini25');
    });

    // ---- R3 P1-2: colon-format ref with embedded feature ID (partial scrub) ----

    it('scrubs colon-format refs containing embedded feature IDs completely', () => {
      const verdict = parseVerdictHandoffPacket(
        makeVerdict({
          phenomenon: 'see snapshot:eval-F167-2026-05-21 for baseline comparison',
          rootCauseHypothesis: {
            summary: 'trace:handoff-F192-abc shows the anomaly',
            confidence: 'medium',
            alternatives: ['attr:eval-F167-pre may be stale'],
          },
        }),
      );
      const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
      const json = JSON.stringify(sanitized);
      // Must not leave residual fragments like [ref]-[feature]-2026-05-21
      assert.ok(!json.includes('2026-05-21'), 'should not leave date fragments from scrubbed ref');
      assert.ok(!json.includes('snapshot:'), 'should not leave colon ref prefix');
      assert.ok(!json.includes('trace:'), 'should not leave colon ref prefix');
      assert.ok(!json.includes('attr:'), 'should not leave colon ref prefix');
    });
  });

  // ---- Cloud review P1-2: slash-delimited refs + attribution: prefix ----

  it('scrubs slash-delimited evidence refs and attribution: prefix', () => {
    const verdict = parseVerdictHandoffPacket(
      makeVerdict({
        phenomenon: 'see snapshot:sop-eval/def-123/sess-456 for context',
        rootCauseHypothesis: {
          summary: 'attribution:sop-rule/rule-789 shows the anomaly',
          confidence: 'medium',
          alternatives: ['snapshot:bundle/verdict-abc/snapshot may be stale'],
        },
      }),
    );
    const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
    const json = JSON.stringify(sanitized);
    assert.ok(!json.includes('def-123'), 'should not leak sopDefinitionId');
    assert.ok(!json.includes('sess-456'), 'should not leak sessionId');
    assert.ok(!json.includes('rule-789'), 'should not leak ruleId');
    assert.ok(!json.includes('verdict-abc'), 'should not leak verdictId');
    assert.ok(!json.includes('attribution:'), 'should not leave attribution: prefix');
    assert.ok(!json.includes('snapshot:sop'), 'should not leave partial snapshot ref');
  });

  // ---- Cloud review P1: dailyTrend key/window scrub ----

  it('scrubs internal identifiers from dailyTrend record keys and window', () => {
    const verdict = parseVerdictHandoffPacket(
      makeVerdict({
        dailyTrend: {
          window: 'F167-7d-window',
          current: { F167_ball_drop_rate: 0.18, opus47_latency: 42 },
          baseline: { F167_ball_drop_rate: 0.03, opus47_latency: 30 },
          threshold: { F167_ball_drop_rate: 0.1, opus47_latency: 50 },
          direction: 'regressed',
        },
      }),
    );
    const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
    const json = JSON.stringify(sanitized);
    assert.ok(!json.includes('F167'), 'dailyTrend keys/window should not contain feature IDs');
    assert.ok(!json.includes('opus47'), 'dailyTrend keys should not contain cat identities');
    // Values (numbers) should be preserved
    assert.ok(json.includes('0.18'), 'numeric values should be preserved');
    assert.ok(json.includes('42'), 'numeric values should be preserved');
  });

  // ---- Cloud review P2: colliding scrubbed trend keys ----

  it('disambiguates colliding scrubbed dailyTrend record keys', () => {
    const verdict = parseVerdictHandoffPacket(
      makeVerdict({
        dailyTrend: {
          window: '7d',
          current: { F167_latency: 10, F192_latency: 20 },
          baseline: { F167_latency: 5, F192_latency: 8 },
          threshold: { F167_latency: 15, F192_latency: 25 },
          direction: 'regressed',
        },
      }),
    );
    const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
    // Both values must survive — no silent overwrite
    const currentKeys = Object.keys(sanitized.dailyTrend.current);
    const currentValues = Object.values(sanitized.dailyTrend.current);
    assert.strictEqual(currentKeys.length, 2, 'both metrics should be preserved');
    assert.ok(currentValues.includes(10), 'first metric value should survive');
    assert.ok(currentValues.includes(20), 'second metric value should survive');
    // Keys must not contain internal identifiers
    const allKeys = JSON.stringify(currentKeys);
    assert.ok(!allKeys.includes('F167'), 'scrubbed keys should not contain feature IDs');
    assert.ok(!allKeys.includes('F192'), 'scrubbed keys should not contain feature IDs');
  });

  // ---- Cloud review P2-2: cross-record key mapping consistency ----

  it('uses consistent key mapping across current/baseline/threshold', () => {
    const verdict = parseVerdictHandoffPacket(
      makeVerdict({
        dailyTrend: {
          window: '7d',
          current: { F167_latency: 10, F192_latency: 20 },
          baseline: { F167_latency: 5, F192_latency: 8 },
          threshold: { F167_latency: 15, F192_latency: 25 },
          direction: 'regressed',
        },
      }),
    );
    const sanitized = sanitizeVerdictForExport(verdict, 'my-instance');
    // The same scrubbed key must map to the same original metric across all records.
    // current[key_X] = F167 value → baseline[key_X] must also = F167 value
    const cKeys = Object.keys(sanitized.dailyTrend.current);
    const bKeys = Object.keys(sanitized.dailyTrend.baseline);
    const tKeys = Object.keys(sanitized.dailyTrend.threshold);
    // Same key set across all three
    assert.deepStrictEqual(cKeys.sort(), bKeys.sort(), 'baseline keys should match current keys');
    assert.deepStrictEqual(cKeys.sort(), tKeys.sort(), 'threshold keys should match current keys');
    // Values at the same key must come from the same original metric
    for (const key of cKeys) {
      const c = sanitized.dailyTrend.current[key];
      const b = sanitized.dailyTrend.baseline[key];
      const t = sanitized.dailyTrend.threshold[key];
      if (c === 10) {
        // F167 group
        assert.strictEqual(b, 5, 'F167 baseline should be 5');
        assert.strictEqual(t, 15, 'F167 threshold should be 15');
      } else {
        // F192 group
        assert.strictEqual(c, 20, 'F192 current should be 20');
        assert.strictEqual(b, 8, 'F192 baseline should be 8');
        assert.strictEqual(t, 25, 'F192 threshold should be 25');
      }
    }
  });

  // ---- P2 fix: domainId eval: prefix enforcement ----

  describe('parseSanitizedIssuePacket domainId validation', () => {
    /** Build a minimal valid packet for domainId testing. */
    function makePacket(domainId) {
      return {
        id: 'sip-test',
        domainId,
        exportedAt: '2026-05-27T10:00:00+08:00',
        sourceInstanceId: 'test-instance',
        phenomenon: 'Test finding',
        harnessComponent: { componentId: 'test-v1', name: 'Test' },
        evidenceSummary: { snapshotCount: 1, attributionCount: 1, metricCount: 1, traceCount: 1 },
        dailyTrend: {
          window: '7d',
          current: { x: 1 },
          baseline: { x: 0 },
          threshold: { x: 0.5 },
          direction: 'regressed',
        },
        rootCauseHypothesis: { summary: 'test', confidence: 'low', alternatives: ['alt'] },
        verdict: 'keep_observe',
        requestedAction: 'Observe',
        counterarguments: ['Insufficient data'],
      };
    }

    it('rejects domainId without eval: prefix', () => {
      assert.throws(() => parseSanitizedIssuePacket(makePacket('not-even-eval')), /domainId/i);
    });

    it('rejects domainId with uppercase letters after eval:', () => {
      assert.throws(() => parseSanitizedIssuePacket(makePacket('eval:MyDomain')), /domainId/i);
    });

    it('accepts valid eval: prefixed domainId', () => {
      const parsed = parseSanitizedIssuePacket(makePacket('eval:code-review'));
      assert.equal(parsed.domainId, 'eval:code-review');
    });
  });
});
