import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import {
  createAcpSessionState,
  transformAcpEvent,
} from '../../dist/domains/cats/services/agents/providers/acp/acp-event-transformer.js';
import { imageFixture } from '../helpers/acp-image-fixture.js';

const NS = 'clowder.ai/acp.v1';
const init = (contract, extra = {}) => ({
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, _meta: { [NS]: { contractVersion: 1, ...contract } }, ...extra },
});
const model = {
  id: 'model',
  category: 'model',
  currentValue: 'old',
  options: [
    { value: 'old', name: 'old' },
    { value: 'chosen', name: 'Native chosen' },
  ],
};
function service(client, config = {}) {
  return new AcpAgentService({
    catId: 'codex',
    projectRoot: '/fixture',
    mcpSupport: false,
    poolKey: { projectPath: '/fixture', providerProfile: 'fixture' },
    pool: {
      async acquire() {
        return { client, release() {} };
      },
      rememberSession() {},
    },
    ...config,
  });
}
async function collect(svc, options) {
  const events = [];
  for await (const event of svc.invoke('Synthetic prompt', options)) events.push(event);
  return events;
}
for (const transport of ['stdio', 'http']) {
  for (const stopReason of ['cancelled', 'refusal', 'max_tokens', 'max_turn_requests']) {
    test(`${transport}: fresh replacement preserves native ${stopReason}`, async () => {
      const f = await imageFixture(transport, '/fixture', {
        resumeEmpty: true,
        promptResult: (msg) => ({ stopReason: msg.params.sessionId === 'existing' ? 'end_turn' : stopReason }),
      });
      try {
        const events = await collect(service(f.client), { sessionId: 'existing' });
        assert.equal(events.find((e) => e.type === 'error')?.errorCode, stopReason);
        assert.equal(f.captured.filter((p) => p.method === 'session/prompt').length, 2);
      } finally {
        await f.close();
      }
    });
  }
  test(`${transport}: config acknowledgement without readback cannot start prompt`, async () => {
    const f = await imageFixture(transport, '/fixture', {
      sessionResult: { configOptions: [model] },
      configResult: {},
    });
    try {
      const events = await collect(service(f.client, { sessionModel: 'chosen' }));
      assert.equal(f.captured.filter((p) => p.method === 'session/prompt').length, 0);
      assert.equal(events.find((e) => e.type === 'error')?.errorCode, 'model_readback_mismatch');
    } finally {
      await f.close();
    }
  });
  test(`${transport}: model alias readback is distinct from unobserved served model`, async () => {
    const f = await imageFixture(transport, '/fixture', {
      sessionResult: { configOptions: [{ ...model, currentValue: 'chosen' }] },
    });
    try {
      const events = await collect(service(f.client, { sessionModel: 'Native chosen' }));
      const final = events.findLast((e) => e.type === 'done');
      assert.equal(final.metadata.diagnostics.acpModel.effectiveModel, 'chosen');
      assert.equal(final.metadata.servedModel, undefined);
      assert.equal(f.captured.filter((p) => p.method === 'session/set_config_option').length, 0);
    } finally {
      await f.close();
    }
  });
  test(`${transport}: required trusted service instructions block before user body`, async () => {
    const f = await imageFixture(transport, '/fixture');
    try {
      const events = await collect(service(f.client, { executionRequirements: { trustedInstructions: true } }), {
        systemPrompt: 'Synthetic trusted instruction',
      });
      assert.equal(events.find((e) => e.type === 'error')?.errorCode, 'trusted_instructions_unsupported');
      assert.equal(f.captured.filter((p) => p.method === 'session/prompt').length, 0);
    } finally {
      await f.close();
    }
  });
  test(`${transport}: native instruction receipt matches session revision roles and hashes`, async () => {
    const instructions = { revision: 'r1', entries: [{ role: 'system', content: 'Synthetic marker' }] };
    const receipt = {
      sessionId: 'fresh-1',
      revision: 'r1',
      nativeSource: 'systemPrompt',
      entries: [{ role: 'system', sha256: createHash('sha256').update('Synthetic marker').digest('hex') }],
    };
    const f = await imageFixture(transport, '/fixture', {
      initializeResult: init({ instructions: { roles: ['system'], nativeSources: ['systemPrompt'] } }),
      sessionResult: { _meta: { [NS]: { instructionsApplied: receipt } } },
    });
    try {
      await f.client.newSession('/fixture', [], { instructions });
      assert.deepEqual(f.captured.find((p) => p.method === 'session/new').params._meta[NS].instructions, instructions);
    } finally {
      await f.close();
    }
  });
  test(`${transport}: invalid native instruction source is rejected`, async () => {
    const instructions = { revision: 'r1', entries: [{ role: 'system', content: 'Synthetic marker' }] };
    const receipt = {
      sessionId: 'fresh-1',
      revision: 'r1',
      nativeSource: '',
      entries: [{ role: 'system', sha256: createHash('sha256').update('Synthetic marker').digest('hex') }],
    };
    const f = await imageFixture(transport, '/fixture', {
      initializeResult: init({ instructions: { roles: ['system'], nativeSources: ['systemPrompt'] } }),
      sessionResult: { _meta: { [NS]: { instructionsApplied: receipt } } },
    });
    try {
      await assert.rejects(f.client.newSession('/fixture', [], { instructions }), /receipt|source/);
    } finally {
      await f.close();
    }
  });
  test(`${transport}: public capability provenance excludes arbitrary private metadata`, async () => {
    const f = await imageFixture(transport, '/fixture', {
      initializeResult: init(
        { privateMarker: 'SyntheticSecretDoNotProject' },
        { future: { token: 'SyntheticSecretDoNotProject' } },
      ),
    });
    try {
      assert.equal(JSON.stringify(f.client.capabilityProvenance()).includes('SyntheticSecretDoNotProject'), false);
      assert.equal(f.client.capabilityProvenance().nativeVerification, 'unverified');
    } finally {
      await f.close();
    }
  });
  test(`${transport}: full prompt result reaches the canonical done event`, async () => {
    const result = { stopReason: 'end_turn', usage: { inputTokens: 3 }, _meta: { synthetic: { preserved: true } } };
    const f = await imageFixture(transport, '/fixture', { promptResult: result });
    try {
      const events = await collect(service(f.client));
      assert.deepEqual(events.findLast((e) => e.type === 'done').metadata.diagnostics.acpPromptResult, result);
    } finally {
      await f.close();
    }
  });
}
test('context use is not last-turn input; session cost is not invocation USD', () => {
  const msg = transformAcpEvent(
    {
      sessionId: 'native',
      update: { sessionUpdate: 'usage_update', used: 12, size: 100, cost: { amount: 2, currency: 'EUR' } },
    },
    'codex',
    { provider: 'fixture', model: 'fixture' },
    createAcpSessionState(),
  );
  assert.deepEqual(msg.metadata.usage, { contextUsedTokens: 12, contextWindowSize: 100 });
  assert.equal(msg.metadata.diagnostics.acpUsage.cost.currency, 'EUR');
});
test('negative and nonfinite context cannot become authoritative', () => {
  assert.equal(
    transformAcpEvent(
      { sessionId: 'native', update: { sessionUpdate: 'usage_update', used: -1, size: Infinity } },
      'codex',
      { provider: 'fixture', model: 'fixture' },
      createAcpSessionState(),
    ),
    null,
  );
  assert.equal(service({}).contextCapability().authoritativeUsage, false);
});
