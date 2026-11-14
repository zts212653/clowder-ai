import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ContextEpochOwner } from '../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../dist/domains/cats/services/stores/ports/ContextEpochStore.js';

for (const mode of ['cold', 'hot', 'rebuilt']) {
  test(`F332 ${mode}: the actual provider request receives a fresh directory independently of cold-only cues`, async () => {
    const prompts = [];
    const reads = [];
    let version = 1;
    const deps = {
      registry: {
        create: async () => ({ invocationId: `f332-${mode}`, callbackToken: 'test-token' }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => (mode === 'hot' ? 'existing-native' : undefined),
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      matterMemoryService: {
        async catalog(actor, options) {
          reads.push({ actor, options });
          return {
            items: [
              { matterId: 'matter-actual', title: `Current matter v${version}`, revision: version, entryCount: 2 },
            ],
          };
        },
      },
    };
    const service = {
      async *invoke(prompt, options) {
        prompts.push({ prompt, sessionId: options?.sessionId });
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
      ...(mode === 'rebuilt'
        ? {
            contextCapability: () => ({
              provider: 'openai',
              carrier: 'app_server',
              reportsRuntimeWindow: false,
              authoritativeUsage: false,
              usageTelemetry: 'unavailable',
              nativeWindowControl: false,
              nativeCompressionControl: false,
              observesCompression: true,
              reason: 'test',
            }),
            async *invokeWithContinuityPreflight(preflight) {
              const settled = await preflight.settle({
                evidence: { kind: 'started', runtimeSessionId: 'rebuilt-native' },
              });
              prompts.push({ prompt: settled.prompt });
              yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            },
          }
        : {}),
    };
    const params = {
      catId: 'opus',
      service,
      prompt: 'Continue the implementation',
      userId: 'owner',
      threadId: `matter-${mode}`,
      isLastCat: true,
      ownerAuthProvenance: 'strict',
      invocationOrigin: mode === 'hot' ? 'a2a' : 'interactive',
      ...(mode === 'rebuilt'
        ? { contextPromptFactory: async () => ({ prompt: 'rebuilt user context', promptMessageIds: [] }) }
        : {}),
    };
    for await (const _ of invokeSingleCat(deps, params)) {
    }
    version = 2;
    for await (const _ of invokeSingleCat(deps, params)) {
    }
    assert.equal(prompts.length, 2);
    assert.match(prompts[0].prompt, /Current matter v1/);
    assert.match(prompts[1].prompt, /Current matter v2/);
    assert.doesNotMatch(prompts[1].prompt, /Current matter v1/);
    assert.match(prompts[1].prompt, /cat_cafe_read_memory_matter/);
    assert.ok(reads.every(({ actor }) => actor.userId === 'owner' && actor.viewer.catId === 'opus'));
    assert.ok(reads.every(({ options }) => options.threadId === params.threadId));
    if (mode === 'hot') assert.equal(prompts[0].sessionId, 'existing-native');
    if (mode === 'rebuilt') assert.match(prompts[0].prompt, /rebuilt user context/);
  });
}
