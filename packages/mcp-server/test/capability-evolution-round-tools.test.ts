import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import {
  capabilityEvolutionRoundTools,
  constituteEvolutionProgramInputSchema,
  handleConstituteEvolutionProgram,
  handleOpenEvolutionRound,
  handleRecordEvolutionEvaluation,
  openEvolutionRoundInputSchema,
  recordEvolutionEvaluationInputSchema,
} from '../dist/tools/capability-evolution-round-tools.js';

/**
 * The actor who drives a Program is a cat, and a cat can only reach what MCP exposes. These assert
 * the journey is actually walkable end to end, and that the thin entries stay thin: they must reach
 * the same canonical callback API, and they must refuse to carry owner truth.
 */

const programId = 'evolution-program:11111111111111111111111111111111';
const ref = (ownerFeatureId: string, ownerStateRef: string) => ({ ownerFeatureId, ownerStateRef });

describe('F311 Phase 3 cat-facing round actions', () => {
  const saved: Record<string, string | undefined> = {};
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let previousFetch: typeof globalThis.fetch;

  beforeEach(() => {
    for (const key of ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN']) {
      saved[key] = process.env[key];
    }
    process.env.CAT_CAFE_API_URL = 'http://localhost:3102';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-f311';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-f311';
    previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ outcome: 'appended' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    requests.length = 0;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const body = () => JSON.parse(String(requests.at(-1)?.init.body));

  it('reaches the canonical callback API for constitution, round and evaluation', async () => {
    await handleConstituteEvolutionProgram({
      programId,
      expectedSequence: 1,
      clientMessageId: 'constitute-1',
      certificates: {
        goal: ref('F311', 'goal:p'),
        measurement: ref('F267', 'measurement-certificate:p'),
        economic: ref('F311', 'economic:p'),
      },
      valueOwnerRef: ref('F311', 'value-owner:p'),
      measurementRoleRefs: {
        observer: ref('F267', 'observer:p'),
        domainOwner: ref('F267', 'domain-owner:p'),
        consumer: ref('F267', 'consumer:p'),
        calibrator: ref('F267', 'calibrator:p'),
      },
    });
    assert.match(String(requests.at(-1)?.url), /\/api\/callbacks\/evolution-programs\/.+\/constitution$/);

    await handleOpenEvolutionRound({
      programId,
      expectedSequence: 3,
      clientMessageId: 'round-1',
      evidenceProofRef: ref('F267', 'measurement-proof:proof-1'),
    });
    assert.match(String(requests.at(-1)?.url), /\/api\/callbacks\/evolution-programs\/.+\/evaluation-rounds$/);
    // Identity only: no trigger receipt, no exposure proof.
    assert.deepEqual(Object.keys(body()).sort(), ['clientMessageId', 'evidenceProofRef', 'expectedSequence']);

    await handleRecordEvolutionEvaluation({
      programId,
      expectedSequence: 4,
      clientMessageId: 'measure-1',
      action: { kind: 'measurement', measurement: { evidenceProofRef: ref('F267', 'measurement-proof:proof-1') } },
    });
    assert.match(String(requests.at(-1)?.url), /\/api\/callbacks\/evolution-programs\/.+\/evaluations$/);
  });

  it('carries the intervention gate with an empty action body', async () => {
    // The card, both falsifiers, the holdout and the gate receipt are owner-held. A cat asks the
    // Program to run its gate; it does not hand the Program the evidence for passing it.
    await handleRecordEvolutionEvaluation({
      programId,
      expectedSequence: 6,
      clientMessageId: 'gate-1',
      action: { kind: 'intervention', intervention: {} },
    });
    assert.deepEqual(body().action, { kind: 'intervention', intervention: {} });
  });

  it('refuses owner truth at the schema, not at the server', async () => {
    const evaluation = z.object(recordEvolutionEvaluationInputSchema).strict();
    // An owner verdict on the measurement.
    assert.equal(
      evaluation.safeParse({
        programId,
        expectedSequence: 4,
        clientMessageId: 'measure-1',
        action: {
          kind: 'measurement',
          measurement: { evidenceProofRef: ref('F267', 'measurement-proof:p'), ownerDecisionStatus: 'usable' },
        },
      }).success,
      false,
    );
    // A caller-stated ruler on the attribution.
    assert.equal(
      evaluation.safeParse({
        programId,
        expectedSequence: 5,
        clientMessageId: 'attribute-1',
        action: {
          kind: 'attribution',
          measurement: { evidenceProofRef: ref('F267', 'measurement-proof:p') },
          attribution: { candidates: [], currentRubricRef: ref('F192', 'rubric:x') },
        },
      }).success,
      false,
    );
    // A caller-stated card on the gate.
    assert.equal(
      evaluation.safeParse({
        programId,
        expectedSequence: 6,
        clientMessageId: 'gate-1',
        action: { kind: 'intervention', intervention: { cardRef: ref('F267', 'intervention-card:c1') } },
      }).success,
      false,
    );
    // A trigger receipt on the round request.
    assert.equal(
      z
        .object(openEvolutionRoundInputSchema)
        .strict()
        .safeParse({
          programId,
          expectedSequence: 3,
          clientMessageId: 'round-1',
          evidenceProofRef: ref('F267', 'measurement-proof:p'),
          triggerReceiptRef: ref('F192', 'eval-trigger-receipt:forged'),
        }).success,
      false,
    );
  });

  it('rejects a non-canonical owner ref shape at constitution', async () => {
    // A repository path is not an owner identity; the schema says so before anything is appended.
    assert.equal(
      z
        .object(constituteEvolutionProgramInputSchema)
        .strict()
        .safeParse({
          programId,
          expectedSequence: 1,
          clientMessageId: 'constitute-1',
          certificates: {
            goal: ref('F311', 'goal:p'),
            measurement: ref('F267', 'docs/harness-feedback/certificates/x.yaml'),
            economic: ref('F311', 'economic:p'),
          },
          valueOwnerRef: ref('F311', 'value-owner:p'),
          measurementRoleRefs: {
            observer: ref('F267', 'observer:p'),
            domainOwner: ref('F267', 'domain-owner:p'),
            consumer: ref('F267', 'consumer:p'),
            calibrator: ref('F267', 'calibrator:p'),
          },
        }).success,
      false,
    );
  });

  it('registers all three actions as write-risk canonical tools', () => {
    assert.deepEqual(capabilityEvolutionRoundTools.map((tool) => tool.name).sort(), [
      'cat_cafe_constitute_evolution_program',
      'cat_cafe_open_evolution_round',
      'cat_cafe_record_evolution_evaluation',
    ]);
  });
});
