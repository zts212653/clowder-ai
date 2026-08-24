import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEVELOPMENT_SOP_DEFINITION } from '../../../shared/dist/types/sop-definition.generated.js';
import { evaluateSopDefinition } from '../../dist/infrastructure/harness-eval/sop/sop-predicate-evaluator.js';

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
const ROUTE_PATH = 'packages/api/src/routes/session-transcript.ts';
const GUARD_COMMAND = 'node --test packages/api/test/session-transcript-route.test.js';

const baseTrace = {
  sessionId: 'session-f303',
  sopDefinitionId: 'development',
  observedStage: 'review',
  commands: [],
  changedFiles: [],
  changedFileEvents: [],
  envSnapshot: { REDIS_URL: 'redis://localhost:6398' },
  gitState: { branch: 'feat/f303', ahead: 0, behind: 0, clean: true },
  handles: { author: 'codex-sol', reviewer: 'kimi' },
  shaContext: {},
};

function routeTrace(overrides = {}) {
  return {
    ...baseTrace,
    changedFiles: [ROUTE_PATH],
    diffContext: {
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      files: [
        {
          path: ROUTE_PATH,
          addedLines: [
            "app.get('/api/threads/:threadId/invocations', async (request, reply) => {",
            'const visibleSessions = sessions.filter((session) => canAccessSessionThread(thread, session, userId));',
          ],
        },
      ],
    },
    ...overrides,
  };
}

function completePacket(overrides = {}) {
  return {
    exactHeadSha: HEAD_SHA,
    riskClaims: [
      {
        id: 'consumer-thread-invocations',
        kind: 'consumer_delta',
        summary: 'The new trajectory route reuses canonical thread access policy.',
        canonicalSource: 'packages/api/src/routes/session-transcript.ts#canAccessSessionThread',
        consumerEvidence: `rg -n "canAccessSessionThread" ${ROUTE_PATH} => 1 new route consumer`,
        claimGuard: {
          command: GUARD_COMMAND,
          redWhen: 'an indexed system thread is rejected by the new route',
        },
      },
    ],
    targetedSelfCheckReceipts: [
      {
        claimId: 'consumer-thread-invocations',
        headSha: HEAD_SHA,
        command: GUARD_COMMAND,
        exitCode: 0,
      },
    ],
    ...overrides,
  };
}

function evaluate(trace) {
  const result = evaluateSopDefinition(DEVELOPMENT_SOP_DEFINITION, trace).find(
    (candidate) => candidate.ruleId === 'impl-design-gate-evidence',
  );
  assert.ok(result, 'generated development SOP must include impl-design-gate-evidence');
  return result;
}

function assertViolation(result, messagePattern) {
  assert.equal(result.status, 'violation');
  assert.ok(result.violation);
  assert.match(result.violation.message, messagePattern);
  return result.violation;
}

describe('Predicate: design_gate_evidence (F303 Phase C)', () => {
  it('RED: fails closed when a candidate route change omits exact diff context', () => {
    const result = evaluate({ ...baseTrace, changedFiles: [ROUTE_PATH] });

    assertViolation(result, /exact diff context/i);
  });

  it('RED: rejects a #3787-like route/helper diff without a consumer-delta review packet', () => {
    const result = evaluate(routeTrace());

    const violation = assertViolation(result, /consumer_delta|review packet/i);
    assert.match(violation.traceAnchor, /session-transcript/);
  });

  it('RED: rejects eligible evidence that omits the consumer-delta declaration', () => {
    const packet = completePacket({
      riskClaims: [
        {
          ...completePacket().riskClaims[0],
          kind: 'preservation_boundary_delta',
        },
      ],
    });

    const result = evaluate(routeTrace({ designGateReviewPacket: packet }));

    assertViolation(result, /consumer_delta/);
  });

  it('RED: rejects a claim without concrete consumer evidence', () => {
    const packet = completePacket({
      riskClaims: [{ ...completePacket().riskClaims[0], consumerEvidence: '' }],
    });

    const result = evaluate(routeTrace({ designGateReviewPacket: packet }));

    assertViolation(result, /consumer evidence/i);
  });

  it('GREEN: accepts the #3787-like diff with complete evidence and an exact-HEAD successful receipt', () => {
    const result = evaluate(routeTrace({ designGateReviewPacket: completePacket() }));

    assert.equal(result.status, 'pass');
  });

  it('RED: fails closed when the packet HEAD does not match the diff HEAD', () => {
    const result = evaluate(routeTrace({ designGateReviewPacket: completePacket({ exactHeadSha: OTHER_SHA }) }));

    assertViolation(result, /exact HEAD/i);
  });

  it('RED: fails closed when the targeted self-check receipt failed', () => {
    const packet = completePacket({
      targetedSelfCheckReceipts: [{ ...completePacket().targetedSelfCheckReceipts[0], exitCode: 1 }],
    });

    const result = evaluate(routeTrace({ designGateReviewPacket: packet }));

    assertViolation(result, /successful targeted self-check receipt/i);
  });

  it('RED: fails closed when the receipt command differs from the claim guard', () => {
    const packet = completePacket({
      targetedSelfCheckReceipts: [{ ...completePacket().targetedSelfCheckReceipts[0], command: 'pnpm check' }],
    });

    const result = evaluate(routeTrace({ designGateReviewPacket: packet }));

    assertViolation(result, /successful targeted self-check receipt/i);
  });

  it('RED: rejects a receipt that points at an undeclared risk claim', () => {
    const packet = completePacket({
      targetedSelfCheckReceipts: [
        ...completePacket().targetedSelfCheckReceipts,
        {
          claimId: 'undeclared-claim',
          headSha: HEAD_SHA,
          command: GUARD_COMMAND,
          exitCode: 0,
        },
      ],
    });

    const result = evaluate(routeTrace({ designGateReviewPacket: packet }));

    assertViolation(result, /unknown risk claim/i);
  });

  it('GREEN: keeps an ordinary implementation outside route/consumer paths lightweight', () => {
    const result = evaluate({
      ...baseTrace,
      changedFiles: ['packages/api/src/infrastructure/logging/request-log.ts'],
    });

    assert.equal(result.status, 'pass');
  });

  it('GREEN: keeps docs and test-only changes lightweight', () => {
    const result = evaluate({
      ...baseTrace,
      changedFiles: ['docs/features/F303-design-gate-integrity.md', 'packages/api/test/unrelated.test.js'],
    });

    assert.equal(result.status, 'pass');
  });

  it('GREEN: does not admit a route diff whose added lines do not touch a canonical helper', () => {
    const trace = routeTrace();
    trace.diffContext.files[0].addedLines = ["router.get('/health', healthHandler);"];

    const result = evaluate(trace);

    assert.equal(result.status, 'pass');
  });
});
