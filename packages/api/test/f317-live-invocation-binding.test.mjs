import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { invokeSingleCat } from '../src/domains/cats/services/agents/invocation/invoke-single-cat.ts';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.ts';

let directory;
let oldAudit;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'f317-child-binding-'));
  oldAudit = process.env.AUDIT_LOG_DIR;
  process.env.AUDIT_LOG_DIR = directory;
});
after(async () => {
  if (oldAudit === undefined) delete process.env.AUDIT_LOG_DIR;
  else process.env.AUDIT_LOG_DIR = oldAudit;
  await rm(directory, { recursive: true, force: true });
});

for (const live of [true, false]) {
  test(`freshness uses ${live ? 'the Live child credential' : 'the ordinary parent execution'} identity`, async () => {
    let bound;
    let capabilityOptions;
    let active = true;
    const capability = {
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
    };
    const port = {
      finished: Promise.resolve(),
      acceptsFreshness: () => active,
      isActiveCarrier: (query) =>
        query.invocationId === 'child' && query.threadId === 'home' && query.catId === 'codex',
    };
    const service = {
      freshnessCarrierCapability: (options) => {
        capabilityOptions = options;
        return capability;
      },
      async *invoke() {
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    for await (const _message of invokeSingleCat(
      {
        registry: {
          create: async () => ({ invocationId: 'child', callbackToken: 'child-token' }),
          verify: async () => ({ ok: false }),
        },
        sessionManager: {
          get: async () => undefined,
          getOrCreate: async () => ({}),
          store: async () => {},
          delete: async () => {},
          resolveWorkingDirectory: () => directory,
        },
        threadStore: null,
        apiUrl: 'http://127.0.0.1:3512',
        providerNativeFreshnessFactory: async (input) => {
          bound = input;
          return null;
        },
      },
      {
        catId: 'codex',
        service,
        prompt: 'read-only synthetic fixture',
        userId: 'owner',
        threadId: 'home',
        parentInvocationId: 'parent',
        isLastCat: true,
        ...(live ? { liveCompanion: port } : {}),
      },
    )) {
    }
    assert.ok(bound, 'the ordinary invocation must create its freshness consumer');
    assert.equal(bound.invocationId, live ? 'child' : 'parent');
    if (live) {
      assert.equal(capabilityOptions.liveCompanion, port);
      assert.equal(bound.liveResultConsumerActive(), true, 'a distinct parent must not mute the actual Live child');
      active = false;
      assert.equal(bound.liveResultConsumerActive(), false, 'revoking Live access still silences the consumer');
    } else assert.equal(bound.liveResultConsumerActive, undefined);
  });
}

test('Live declares the app-server carrier it actually uses even when ordinary text uses exec', () => {
  const service = new CodexAgentService({ carrierMode: 'exec_json', model: 'gpt-test' });
  assert.equal(service.freshnessCarrierCapability().carrier, 'codex_exec_json');
  assert.deepEqual(service.freshnessCarrierCapability({ liveCompanion: {} }), {
    provider: 'openai_codex',
    carrier: 'codex_app_server',
    deliverySemantics: 'exact_active_turn',
  });
});
