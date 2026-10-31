import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import {
  advanceEvolutionProgramChangeInputSchema,
  capabilityEvolutionChangeTools,
  handleAdvanceEvolutionProgramChange,
} from '../dist/tools/capability-evolution-change-tools.js';

const programId = 'evolution-program:11111111111111111111111111111111';

describe('F311 Phase 4 cat-facing change action', () => {
  const saved: Record<string, string | undefined> = {};
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let previousFetch: typeof globalThis.fetch;

  beforeEach(() => {
    for (const key of ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN']) {
      saved[key] = process.env[key];
    }
    process.env.CAT_CAFE_API_URL = 'http://localhost:3102';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-f311-phase4';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-f311-phase4';
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

  it('reaches the canonical callback API with operation-only actions', async () => {
    for (const [sequence, action] of [
      [7, { kind: 'propose' }],
      [8, { kind: 'sync' }],
      [11, { kind: 'decide', decision: 'no_change' }],
    ] as const) {
      await handleAdvanceEvolutionProgramChange({
        programId,
        expectedSequence: sequence,
        clientMessageId: `change-${action.kind}`,
        action,
      });
      assert.match(String(requests.at(-1)?.url), /\/api\/callbacks\/evolution-programs\/.+\/changes$/);
      assert.deepEqual(body(), {
        expectedSequence: sequence,
        clientMessageId: `change-${action.kind}`,
        action,
      });
    }
  });

  it('rejects caller-authored Approval, owner, target and outcome truth', () => {
    const schema = z.object(advanceEvolutionProgramChangeInputSchema).strict();
    const clean = {
      programId,
      expectedSequence: 8,
      clientMessageId: 'change-sync',
      action: { kind: 'sync' },
    };
    assert.equal(schema.safeParse(clean).success, true);
    for (const forged of [
      { ...clean, approvalRef: { ownerFeatureId: 'F246', ownerStateRef: 'approval:forged' } },
      { ...clean, action: { kind: 'sync', targetVersionRef: { version: 'v9' } } },
      { ...clean, interventionReceiptRef: { ownerFeatureId: 'F202', ownerStateRef: 'receipt:forged' } },
      { ...clean, outcomeReceiptRef: { ownerFeatureId: 'F266', ownerStateRef: 'outcome:forged' } },
    ]) {
      assert.equal(schema.safeParse(forged).success, false);
    }
  });

  it('registers one canonical write-risk action instead of a second lifecycle surface', () => {
    assert.deepEqual(
      capabilityEvolutionChangeTools.map((tool) => tool.name),
      ['cat_cafe_advance_evolution_program_change'],
    );
    assert.match(capabilityEvolutionChangeTools[0].description, /agent-key callers may only sync/);
  });
});
