import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  beginEvolutionPreparationInputSchema,
  capabilityEvolutionPreparationTools,
  handleBeginEvolutionPreparationWork,
  handleSubmitEvolutionPreparation,
  submitEvolutionPreparationCommandSchema,
  submitEvolutionPreparationInputSchema,
} from '../dist/tools/capability-evolution-preparation-tools.js';

const PROGRAM_ID = 'evolution-program:00000000000000000000000000000001';

function objectBody() {
  return {
    kind: 'object_map' as const,
    goalStatement: '让 PM Agent 专业地推进项目，只在必要时请人介入',
    summary: 'Prompt, skills, subagents, model fit and environment remain candidates.',
    items: [
      {
        itemId: 'candidate-stack',
        label: 'Candidate stack',
        scope: 'Current PM capability and operating conditions.',
        why: 'Several layers can explain the outcome.',
        modifiability: { state: 'unknown' as const, reason: 'Owner check pending.', basisRefs: [] },
        sourceRefs: [],
        nextAction: 'Resolve owners and exact versions.',
      },
    ],
    unknowns: ['No customer baseline is connected.'],
    nextAction: 'Inspect current sources.',
  };
}

describe('F311 preparation MCP actions', () => {
  const saved: Record<string, string | undefined> = {};
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let previousFetch: typeof globalThis.fetch;

  beforeEach(() => {
    for (const key of ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN']) {
      saved[key] = process.env[key];
    }
    process.env.CAT_CAFE_API_URL = 'http://localhost:3102';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-preparation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'token-preparation';
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

  it('registers only the current authenticated invocation as real section work', async () => {
    const input = {
      programId: PROGRAM_ID,
      expectedSequence: 1,
      clientMessageId: 'begin-preparation',
      section: 'object_map' as const,
      itemId: 'candidate-stack',
      focus: 'Inspect owners and exact versions.',
      expectedCurrentSubmissionRef: null,
    };
    await handleBeginEvolutionPreparationWork(input);

    assert.deepEqual(Object.keys(beginEvolutionPreparationInputSchema).sort(), [
      'clientMessageId',
      'expectedCurrentSubmissionRef',
      'expectedSequence',
      'focus',
      'itemId',
      'programId',
      'section',
    ]);
    assert.equal(
      new URL(requests[0].url).pathname,
      `/api/callbacks/evolution-programs/${encodeURIComponent(PROGRAM_ID)}/preparation/work`,
    );
    const { programId: _programId, ...body } = input;
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), body);
    assert.equal(requests[0].init.headers?.['x-invocation-id'], 'inv-preparation');
  });

  it('submits one typed section revision without caller-authored identity or revision fields', async () => {
    const input = {
      programId: PROGRAM_ID,
      expectedSequence: 2,
      clientMessageId: 'submit-preparation',
      section: 'object_map' as const,
      title: '可进化对象',
      expectedCurrentSubmissionRef: null,
      dependsOn: [],
      body: objectBody(),
    };
    await handleSubmitEvolutionPreparation(input);

    assert.deepEqual(Object.keys(submitEvolutionPreparationInputSchema).sort(), [
      'body',
      'clientMessageId',
      'dependsOn',
      'expectedCurrentSubmissionRef',
      'expectedSequence',
      'programId',
      'section',
      'title',
    ]);
    assert.equal(
      new URL(requests[0].url).pathname,
      `/api/callbacks/evolution-programs/${encodeURIComponent(PROGRAM_ID)}/preparation/submissions`,
    );
    const { programId: _programId, ...body } = input;
    assert.deepEqual(JSON.parse(String(requests[0].init.body)), body);
    assert.equal(JSON.stringify(requests[0].init.body).includes('authorCatId'), false);
    assert.equal(JSON.stringify(requests[0].init.body).includes('revision'), false);
  });

  it('rejects a mismatched section/body, malformed current ref and caller-owned fields before HTTP', async () => {
    const base = {
      programId: PROGRAM_ID,
      expectedSequence: 2,
      clientMessageId: 'bad-preparation',
      section: 'measurement_plan' as const,
      title: '测量与实验准备',
      expectedCurrentSubmissionRef: null,
      dependsOn: [],
      body: objectBody(),
    };
    assert.equal(submitEvolutionPreparationCommandSchema.safeParse(base).success, false);
    assert.equal(
      submitEvolutionPreparationInputSchema.expectedCurrentSubmissionRef.safeParse({
        ownerFeatureId: 'F311',
        ownerStateRef: `preparation-submission:${PROGRAM_ID}:object_map`,
        version: 'latest',
      }).success,
      false,
    );
    assert.throws(() => handleSubmitEvolutionPreparation({ ...base, actorRef: 'cat:spoof' } as never));
    assert.equal(requests.length, 0);
  });

  it('exposes both write actions only to the full invocation profile with a complete route contract', () => {
    assert.deepEqual(
      capabilityEvolutionPreparationTools.map((tool) => tool.name),
      ['cat_cafe_begin_evolution_preparation_work', 'cat_cafe_submit_evolution_preparation'],
    );
    for (const tool of capabilityEvolutionPreparationTools) {
      assert.deepEqual(tool.policy.runtimeProfiles, ['full']);
      assert.deepEqual(
        tool.operation.kind === 'single'
          ? tool.operation.boundary.authorizationPaths.map((path) => path.principal)
          : [],
        ['invocation-cat'],
      );
      assert.match(tool.description, /Use when:/);
      assert.match(tool.description, /NOT for:/);
      assert.match(tool.description, /Output:/);
      assert.match(tool.description, /GOTCHA:/);
    }
  });
});
