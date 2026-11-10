import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANONICAL_TOOL_REGISTRY } from '../dist/canonical-server-tools.js';
import { projectRegistrationContract } from '../dist/tool-registration-contract.js';
import { createPersonMemoryLifecycleTools } from '../dist/tools/person-memory-lifecycle-tools.js';

const retiredNames = [
  'cat_cafe_correct_person_claim', // mcp-cutover-negative-reference: absence
  'cat_cafe_retire_person_claim', // mcp-cutover-negative-reference: absence
  'cat_cafe_amend_person_interaction', // mcp-cutover-negative-reference: absence
];
const cases = [
  {
    action: 'correct_claim',
    path: 'correct-claim',
    prefix: 'correction_',
    input: {
      expectedCurrentClaimId: 'person_claim_current',
      payload: { kind: 'reported_fact', predicate: 'role', value: 'editor', assertedBy: 'owner' },
    },
  },
  {
    action: 'retire_claim',
    path: 'retire-claim',
    prefix: 'retirement_',
    input: { expectedCurrentClaimId: 'person_claim_current' },
  },
  {
    action: 'amend_event',
    path: 'amend-event',
    prefix: 'amendment_',
    input: {
      expectedEventId: 'person_event_current',
      payload: {
        eventKind: 'meeting',
        headline: 'Discussed the draft',
        importanceOrTopic: 'Corrected the meeting topic',
        uncertaintyNotes: [],
        occurredAt: { kind: 'approximate', raw: 'last week', qualifier: 'about' },
      },
    },
  },
];
const callbackResult = { content: [{ type: 'text', text: '{"status":"corrected"}' }] };

function revisionTool(requests, response = callbackResult) {
  const tools = createPersonMemoryLifecycleTools(
    async (path, body) => {
      requests.push({ path, body });
      return response;
    },
    async () => callbackResult,
  );
  const tool = tools.tools.find((entry) => entry.name === 'cat_cafe_revise_person_memory');
  assert.ok(tool, 'the combined person revision entry must be available');
  return tool;
}

test('person revision replaces three names without absorbing read or destructive tools', () => {
  const names = CANONICAL_TOOL_REGISTRY.map((tool) => tool.name);
  for (const name of retiredNames) assert.equal(names.includes(name), false, `${name} must be retired`);
  const tool = revisionTool([]);
  assert.deepEqual(tool.actionInventory, ['amend_event', 'correct_claim', 'retire_claim']);
  assert.equal(tool.operation.kind, 'discriminated');
  assert.deepEqual(tool.policy.runtimeProfiles, ['full']);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.ok(names.includes('cat_cafe_drill_person_memory'));
  assert.ok(names.includes('cat_cafe_redact_person_memory_item'));
});

for (const scenario of cases) {
  test(`${scenario.action} preserves its original route, exact source, payload and retry key`, async () => {
    const requests = [];
    const tool = revisionTool(requests);
    const input = {
      action: scenario.action,
      personId: 'person_existing',
      ...scenario.input,
      sourceMessageId: 'owner_source',
      clientRequestId: 'same-retry-key',
    };
    assert.deepEqual(await tool.handler(input), callbackResult);
    assert.deepEqual(requests, [
      {
        path: `/api/callbacks/person-memory/${scenario.path}`,
        body: {
          personId: 'person_existing',
          ...scenario.input,
          sourceMessageId: 'owner_source',
          requestId: 'same-retry-key',
        },
      },
    ]);
    await tool.handler({ action: scenario.action, personId: 'person_existing', ...scenario.input });
    assert.match(requests[1].body.requestId, new RegExp(`^${scenario.prefix}`));
    assert.equal('sourceMessageId' in requests[1].body, false);
  });
}

test('revision rejects wrong action payloads and caller authority before invoking a callback', async () => {
  const requests = [];
  const tool = revisionTool(requests);
  const valid = { action: 'retire_claim', personId: 'person_existing', ...cases[1].input };
  for (const input of [
    { ...valid, action: 'forget_person' },
    { ...valid, action: 'correct_claim' },
    { ...valid, action: 'amend_event' },
    { ...valid, expectedCurrentClaimId: 'person_event_wrong' },
    { ...valid, ownerUserId: 'someone-else' },
    { ...valid, payload: cases[0].input.payload },
    { ...valid, sourceMessageId: '' },
    { ...valid, action: 'correct_claim', payload: { ...cases[0].input.payload, assertedBy: 'agent' } },
  ]) {
    assert.equal((await tool.handler(input)).isError, true);
  }
  assert.deepEqual(requests, []);
});

test('revision preserves an upstream refusal instead of reporting a successful correction', async () => {
  const failure = { isError: true, content: [{ type: 'text', text: 'stale anchor or source not authorized' }] };
  const tool = revisionTool([], failure);
  assert.deepEqual(
    await tool.handler({ action: 'retire_claim', personId: 'person_existing', ...cases[1].input }),
    failure,
  );
});

test('document verification exposes all four state-changing actions as canonical writes', () => {
  const tool = CANONICAL_TOOL_REGISTRY.find((entry) => entry.name === 'cat_cafe_library_verify');
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.policy.activeState, 'canonical');
  assert.equal(tool.operation.kind, 'discriminated');
  assert.deepEqual(tool.actionInventory, ['confirm', 'dismiss_review', 'escalate', 'mark_stale']);
  assert.deepEqual(tool.policy.runtimeProfiles, ['full']);
});

test('the SDK registration rejects extra authority fields rather than silently stripping them', () => {
  const samples = [
    ['cat_cafe_revise_person_memory', { action: 'retire_claim', personId: 'person_existing', ...cases[1].input }],
    ['cat_cafe_library_verify', { anchor: 'F188', action: 'confirm', actor: 'test-cat' }],
  ];
  for (const [name, input] of samples) {
    const tool = CANONICAL_TOOL_REGISTRY.find((entry) => entry.name === name);
    const { inputSchema } = projectRegistrationContract(tool, 'invocation');
    assert.equal(inputSchema.safeParse(input).success, true);
    assert.equal(inputSchema.safeParse({ ...input, ownerUserId: 'foreign' }).success, false);
  }
});

test('verification retains its HTTP payload and rejects invalid actions before dispatch', async (context) => {
  const requests = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), method: options.method, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, previousStatus: 'needs_review', newStatus: 'reviewed' }) };
  });
  const tool = CANONICAL_TOOL_REGISTRY.find((entry) => entry.name === 'cat_cafe_library_verify');
  for (const action of ['confirm', 'mark_stale', 'escalate', 'dismiss_review']) {
    const input = { anchor: 'F188', action, actor: 'test-cat' };
    assert.notEqual((await tool.handler(input)).isError, true);
    assert.deepEqual(requests.at(-1).body, input);
    assert.match(requests.at(-1).url, /\/api\/f163\/verification\/action$/);
    assert.equal(requests.at(-1).method, 'POST');
  }
  for (const input of [
    { anchor: 'F188', action: 'delete', actor: 'test-cat' },
    { anchor: 'F188', action: 'confirm', actor: 'test-cat', ownerUserId: 'foreign' },
    { anchor: 'F188', action: 'confirm' },
  ]) {
    assert.equal((await tool.handler(input)).isError, true);
  }
  assert.equal(requests.length, 4);
});
