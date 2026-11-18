import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CatCarrier, catRegistry } from '@cat-cafe/shared';
import { AgyNativeAgentService } from '../src/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { ClaudeAgentService } from '../src/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { ClaudeSdkAgentService } from '../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import { KimiAgentService } from '../src/domains/cats/services/agents/providers/KimiAgentService.js';
import { sessionCacheRuntimeKey } from '../src/domains/cats/services/session/cache/session-cache-runtime.js';

test('real catalog members and real service carrier declarations share canonical cache keys', () => {
  const configs = Object.values(catRegistry.getAllConfigs());
  const cases: {
    clientId: string;
    carrier: CatCarrier;
    make: (config: (typeof configs)[number]) => { freshnessCarrierCapability(): { carrier: string } };
  }[] = [
    {
      clientId: 'anthropic',
      carrier: 'cli',
      make: (c) => new ClaudeAgentService({ catId: c.id, model: c.defaultModel }),
    },
    {
      clientId: 'anthropic',
      carrier: 'sdk',
      make: (c) => new ClaudeSdkAgentService({ catId: c.id, model: c.defaultModel }),
    },
    {
      clientId: 'openai',
      carrier: 'cli',
      make: (c) => new CodexAgentService({ catId: c.id, model: c.defaultModel, carrierMode: 'exec_json' }),
    },
    {
      clientId: 'openai',
      carrier: 'app_server',
      make: (c) => new CodexAgentService({ catId: c.id, model: c.defaultModel, carrierMode: 'app_server' }),
    },
    {
      clientId: 'google',
      carrier: 'cli',
      make: (c) => new AgyNativeAgentService({ catId: c.id, profile: { model: c.defaultModel } }),
    },
    { clientId: 'kimi', carrier: 'cli', make: (c) => new KimiAgentService({ catId: c.id, model: c.defaultModel }) },
  ];
  for (const entry of cases) {
    const member = configs.find((config) => config.clientId === entry.clientId);
    assert.ok(member, `real template member for ${entry.clientId}`);
    const config = { ...member, carrier: entry.carrier };
    const service = entry.make(config);
    const observed = { clientId: config.clientId, carrier: service.freshnessCarrierCapability().carrier };
    const originalCarrier = observed.carrier;
    const producerKey = sessionCacheRuntimeKey(observed);
    assert.equal(producerKey, `${config.clientId}:${entry.carrier}`, `provider ${originalCarrier}`);
    assert.equal(producerKey, sessionCacheRuntimeKey(config));
    assert.equal(observed.carrier, originalCarrier, 'normalization must not mutate the Host boundary');
  }
});

test('unrecognized or incompatible service declarations stay unavailable', () => {
  assert.equal(sessionCacheRuntimeKey(undefined), undefined);
  assert.equal(sessionCacheRuntimeKey({ clientId: 'anthropic', carrier: 'undeclared' }), undefined);
  assert.equal(sessionCacheRuntimeKey({ clientId: 'google', carrier: 'claude_print_sdk' }), undefined);
  assert.equal(sessionCacheRuntimeKey({ clientId: 'anthropic', carrier: 'app_server' }), undefined);
});
