import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFrictionAnalysisFinding,
  deriveFrictionChildVerdictId,
  digestFrictionAnalysisFinding,
  parseFrictionAnalysisFindingInputs,
  serializeFrictionAnalysisFinding,
} from '../../dist/infrastructure/harness-eval/friction/friction-finding-artifact.js';

const target = {
  featureId: 'F188',
  componentId: 'evidence-reader',
  ownerCatId: 'codex-sol',
  version: 'repair-target-v1-9f60f978a6c17a761b0be31877d8de03d42b0ea257e9dcbe107ad3c0836845a5',
  resolutionRef: 'feature-thread-owner:v1:F188:thread_f188:codex-sol',
  resolvedAt: '2026-08-29T03:09:18.499Z',
};

function repairJudgment(overrides = {}) {
  return {
    candidateRef: '9028c961c203',
    findingKey: 'evidence-reader-drilldown-path',
    analysisDisposition: 'repair',
    approvalRequirement: { kind: 'required', reason: 'repair' },
    interventionKind: 'fix',
    rationale: 'The reader resolves repo-relative drill refs against the package cwd.',
    uncertainty: 'medium',
    falsifier: {
      condition: 'The same ref opens from both repo root and package cwd.',
      evidenceRef: 'measurement:f313/drilldown-path/falsifier',
    },
    withdrawalCondition: 'Withdraw if the canonical reader already resolves from repo root.',
    measurementResultRef: 'measurement:f267/f313/9028c961c203',
    sourceSignalRefs: ['source-message:0001787835904741-000003-1efb6454#0'],
    repairTargetHint: { featureId: 'F188', componentId: 'evidence-reader' },
    ...overrides,
  };
}

describe('FrictionAnalysisFindingV1', () => {
  it('rejects incomplete findings before artifact construction', () => {
    for (const field of [
      'rationale',
      'falsifier',
      'withdrawalCondition',
      'measurementResultRef',
      'sourceSignalRefs',
      'repairTargetHint',
    ]) {
      const invalid = repairJudgment();
      delete invalid[field];
      assert.throws(() => parseFrictionAnalysisFindingInputs([invalid]), new RegExp(field));
    }
  });

  it('requires repair intervention and Approval while rejecting non-repair intervention leakage', () => {
    assert.throws(
      () => parseFrictionAnalysisFindingInputs([repairJudgment({ interventionKind: undefined })]),
      /interventionKind/,
    );
    assert.throws(
      () => parseFrictionAnalysisFindingInputs([repairJudgment({ approvalRequirement: { kind: 'not_required' } })]),
      /approvalRequirement/,
    );
    assert.throws(
      () =>
        parseFrictionAnalysisFindingInputs([
          repairJudgment({
            analysisDisposition: 'observe',
            approvalRequirement: { kind: 'not_required' },
          }),
        ]),
      /interventionKind/,
    );
  });

  it('accepts only feature/component target hints and rejects caller-owned routing truth', () => {
    for (const forbidden of ['ownerCatId', 'version', 'resolutionRef', 'resolvedAt']) {
      assert.throws(
        () =>
          parseFrictionAnalysisFindingInputs([
            repairJudgment({ repairTargetHint: { featureId: 'F188', [forbidden]: 'caller-value' } }),
          ]),
        new RegExp(forbidden),
      );
    }
  });

  it('builds a deeply immutable, byte-stable artifact and digest from server resolution', () => {
    const [judgment] = parseFrictionAnalysisFindingInputs([repairJudgment()]);
    const finding = buildFrictionAnalysisFinding({
      parentVerdictId: '2026-08-29-eval-friction-pawfeel-breakout-insufficient-keep-observe',
      judgment,
      repairTargetResolution: { status: 'resolved', target },
    });
    const replay = buildFrictionAnalysisFinding({
      parentVerdictId: finding.parentVerdictId,
      judgment,
      repairTargetResolution: { status: 'resolved', target },
    });

    assert.equal(finding.schemaVersion, 1);
    assert.equal(finding.domainId, 'eval:friction');
    assert.equal(finding.repairTargetResolution.target.ownerCatId, 'codex-sol');
    assert.ok(Object.isFrozen(finding));
    assert.ok(Object.isFrozen(finding.falsifier));
    assert.ok(Object.isFrozen(finding.sourceSignalRefs));
    assert.equal(serializeFrictionAnalysisFinding(finding), serializeFrictionAnalysisFinding(replay));
    assert.equal(digestFrictionAnalysisFinding(finding), digestFrictionAnalysisFinding(replay));
    assert.match(digestFrictionAnalysisFinding(finding), /^[a-f0-9]{64}$/);
  });

  it('derives a safe deterministic child verdict id from parent + finding key', () => {
    const parent = '2026-08-29-eval-friction-pawfeel-breakout-insufficient-keep-observe';
    const first = deriveFrictionChildVerdictId(parent, 'evidence-reader-drilldown-path');
    const replay = deriveFrictionChildVerdictId(parent, 'evidence-reader-drilldown-path');
    assert.equal(first, replay);
    assert.match(first, /^[a-z0-9][a-z0-9-]{0,127}$/);
    assert.notEqual(first, deriveFrictionChildVerdictId(parent, 'default-mode-tool-availability'));
  });
});
