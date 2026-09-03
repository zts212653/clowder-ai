import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  capabilityEvolutionTools,
  handleGetEvolutionProgram,
  handleLinkEvolutionProgramObservation,
  handleStartEvolutionProgram,
  handleUpdateEvolutionProgram,
  linkEvolutionProgramObservationInputSchema,
  startEvolutionProgramInputSchema,
  updateEvolutionProgramInputSchema,
} from '../dist/tools/capability-evolution-tools.js';

describe('F311 MCP chat admission', () => {
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

  it('turns “我们来进化 X” into a ref-only permanent create action', async () => {
    await handleStartEvolutionProgram({
      targetRef: { ownerFeatureId: 'F202', ownerStateRef: 'skill:video-forge', version: 'v1' },
      clientMessageId: 'message-start-video-forge',
    });

    assert.deepEqual(Object.keys(startEvolutionProgramInputSchema).sort(), [
      'agentKeyCatId',
      'clientMessageId',
      'targetRef',
    ]);
    assert.equal(startEvolutionProgramInputSchema.agentKeyCatId.isOptional(), true);
    assert.equal(new URL(requests[0].url).pathname, '/api/callbacks/evolution-programs');
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
      targetRef: { ownerFeatureId: 'F202', ownerStateRef: 'skill:video-forge', version: 'v1' },
      clientMessageId: 'message-start-video-forge',
    });
    assert.equal(requests[0].init.headers?.['x-invocation-id'], 'inv-f311');
  });

  it('reads and updates the same Program endpoints', async () => {
    await handleGetEvolutionProgram({ programId: 'evolution-program:abc' });
    await handleUpdateEvolutionProgram({
      programId: 'evolution-program:abc',
      expectedSequence: 1,
      clientMessageId: 'message-pause',
      action: { type: 'pause', reasonRef: { ownerFeatureId: 'F281', ownerStateRef: 'decision:pause' } },
    });

    assert.equal(new URL(requests[0].url).pathname, '/api/callbacks/evolution-programs/evolution-program%3Aabc');
    assert.equal(
      new URL(requests[1].url).pathname,
      '/api/callbacks/evolution-programs/evolution-program%3Aabc/commands',
    );
  });

  it('links observation eyes through a ref-only owner-validated action', async () => {
    const input = {
      programId: 'evolution-program:00000000000000000000000000000001',
      expectedSequence: 2,
      clientMessageId: 'message-observe',
      trajectoryRef: { ownerFeatureId: 'F299', ownerStateRef: 'inv:inv-f311' },
      sourceBindings: [
        {
          sourceKind: 'paw-feel-disposition',
          ownerSurfaceRef: { ownerFeatureId: 'F278', ownerStateRef: 'paw-feel:signal-1' },
          joinKey: 'message:message-1',
          namedConsumerRef: {
            ownerFeatureId: 'F311',
            ownerStateRef: 'evolution-consumer:evolution-program:00000000000000000000000000000001',
          },
          instrumentationRef: { ownerFeatureId: 'F278', ownerStateRef: 'instrumentation:paw-feel-v1' },
        },
        {
          sourceKind: 'human-disposition',
          ownerSurfaceRef: { ownerFeatureId: 'F281', ownerStateRef: 'human-disposition:decision-1' },
          joinKey: 'subject:proposal-1',
          namedConsumerRef: {
            ownerFeatureId: 'F311',
            ownerStateRef: 'evolution-consumer:evolution-program:00000000000000000000000000000001',
          },
          instrumentationRef: {
            ownerFeatureId: 'F281',
            ownerStateRef: 'instrumentation:human-disposition-v1',
          },
        },
      ],
      evidenceProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:proof-1' },
    };

    assert.equal(linkEvolutionProgramObservationInputSchema.trajectoryRef.safeParse(input.trajectoryRef).success, true);
    await handleLinkEvolutionProgramObservation(input);

    assert.equal(
      new URL(requests[0].url).pathname,
      '/api/callbacks/evolution-programs/evolution-program%3A00000000000000000000000000000001/observations',
    );
    const body = JSON.parse(String(requests[0].init.body));
    assert.deepEqual(body, {
      expectedSequence: input.expectedSequence,
      clientMessageId: input.clientMessageId,
      trajectoryRef: input.trajectoryRef,
      sourceBindings: input.sourceBindings,
      evidenceProofRef: input.evidenceProofRef,
    });
    assert.equal(JSON.stringify(body).includes('payload'), false);
  });

  it('describes zero-form admission and typed blockers', () => {
    const start = capabilityEvolutionTools.find((tool) => tool.name === 'cat_cafe_start_evolution_program');
    assert.match(start?.description ?? '', /我们来进化 X/);
    assert.match(start?.description ?? '', /不让用户填写大表/);
    assert.match(start?.description ?? '', /typed blocker/);
    assert.equal(updateEvolutionProgramInputSchema.programId.safeParse('not-a-program').success, false);
    assert.equal(updateEvolutionProgramInputSchema.action.safeParse({ type: 'garbage_collect' }).success, false);
    const link = capabilityEvolutionTools.find((tool) => tool.name === 'cat_cafe_link_evolution_program_observation');
    assert.match(link?.description ?? '', /F299 inv:<id>/);
    assert.match(link?.description ?? '', /typed insufficient/);
    assert.equal(
      linkEvolutionProgramObservationInputSchema.trajectoryRef.safeParse({
        ownerFeatureId: 'F311',
        ownerStateRef: 'inv:inv-f311',
      }).success,
      false,
    );
    assert.equal(linkEvolutionProgramObservationInputSchema.sourceBindings.safeParse([]).success, false);
  });
});
