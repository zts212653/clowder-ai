import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { freezeExecutionAccountBinding } from '../dist/domains/cats/services/agents/invocation/execution-account-binding.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { collect, createMockArchive, createMockProcess, emitEvents } from './helpers/provider-archive-test-helpers.js';

for (const { restricted, managed } of [
  { restricted: false, managed: false },
  { restricted: true, managed: false },
  { restricted: false, managed: true },
]) {
  test(`Codex consumes its admitted global policy; read-only=${restricted}, managed=${managed}`, async (t) => {
    const all = catRegistry.getAllConfigs();
    t.after(() => {
      catRegistry.reset();
      Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    });
    const keys = [
      'CAT_CODEX_SANDBOX_MODE',
      'CAT_CODEX_APPROVAL_POLICY',
      'CAT_CAFE_CODEX_OAUTH_TRANSPORT',
      'CAT_CAFE_CODEX_SERVED_MODEL_OBSERVATION',
      'RUST_LOG',
    ];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    t.after(() =>
      previous.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }),
    );
    process.env.CAT_CODEX_SANDBOX_MODE = restricted ? 'danger-full-access' : 'read-only';
    process.env.CAT_CODEX_APPROVAL_POLICY = 'on-request';
    process.env.CAT_CAFE_CODEX_OAUTH_TRANSPORT = 'builtin';
    process.env.CAT_CAFE_CODEX_SERVED_MODEL_OBSERVATION = 'off';
    delete process.env.RUST_LOG;
    const member = {
      ...catRegistry.getOrThrow('codex').config,
      configurationSource: managed ? 'managed_account' : 'native_tool',
      accountRef: managed ? 'codex' : undefined,
      defaultModel: managed ? 'gpt-5.4' : 'fixture-model',
    };
    catRegistry.reset();
    Object.entries(all)
      .filter(([id]) => id !== 'codex')
      .forEach(([id, config]) => catRegistry.register(id, config));
    catRegistry.register('codex', member);
    const binding = freezeExecutionAccountBinding({
      catId: 'codex',
      catConfig: member,
      workspace: { usesDefaultWorkspace: false },
    });
    process.env.CAT_CODEX_SANDBOX_MODE = 'workspace-write';
    process.env.CAT_CODEX_APPROVAL_POLICY = 'never';
    process.env.CAT_CAFE_CODEX_OAUTH_TRANSPORT = 'https';
    process.env.CAT_CAFE_CODEX_SERVED_MODEL_OBSERVATION = 'on';
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => {
      setImmediate(
        () =>
          void emitEvents(proc, [
            { type: 'thread.started', thread_id: 'policy-fixture-thread' },
            { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'ok' } },
            { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
          ]),
      );
      return proc;
    });
    const service = new CodexAgentService({
      catId: 'codex',
      model: 'fixture-model',
      cliCommand: process.execPath,
      spawnFn,
      rawArchive: createMockArchive(),
      l0CompilerFn: async () => 'FROZEN-L0',
    });
    const messages = await collect(
      service.invoke('isolated task', {
        codexLaunchPolicy: binding.codexLaunchPolicy,
        executionPreferences: binding.executionPreferences,
        ...(managed ? { callbackEnv: { CODEX_AUTH_MODE: 'oauth' } } : {}),
        ...(restricted ? { toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] } } : {}),
      }),
    );
    assert.deepEqual(
      messages.filter((message) => message.type === 'error'),
      [],
    );
    assert.equal(spawnFn.mock.calls.length, 1);
    const args = spawnFn.mock.calls[0].arguments[1];
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only', 'actual sandbox adopted a later global edit');
    assert.ok(
      args.includes(`approval_policy="${restricted ? 'never' : 'on-request'}"`),
      'actual approval policy adopted a later global edit',
    );
    assert.doesNotMatch(
      spawnFn.mock.calls[0].arguments[2].env.RUST_LOG ?? '',
      /codex_api::sse::responses=trace|tungstenite::protocol=trace/,
    );
    if (managed) {
      assert.ok(args.includes('model_provider="openai"'));
      assert.equal(args.includes('model_provider="openai_https"'), false);
    }
  });
}
