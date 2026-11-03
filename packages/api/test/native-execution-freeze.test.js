import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { freezeExecutionAccountBinding } from '../dist/domains/cats/services/agents/invocation/execution-account-binding.js';
import { ClaudeInteractivePtyCarrierService } from '../dist/domains/cats/services/agents/providers/ClaudeInteractivePtyCarrierService.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { collect, createMockProcess, emitEvents } from './helpers/provider-archive-test-helpers.js';

for (const preferences of [
  { model: 'model-a', effort: 'low' },
  { model: '', effort: '' },
]) {
  test(`Codex launches the admitted native choices (${preferences.model || 'inherit'}), after a later edit`, async (t) => {
    const all = catRegistry.getAllConfigs();
    const id = 'native-frozen-preferences';
    const member = {
      ...all.codex,
      id,
      configurationSource: 'native_tool',
      accountRef: undefined,
      defaultModel: preferences.model,
      cli: { ...all.codex.cli, effort: preferences.effort },
    };
    catRegistry.register(id, member);
    t.after(() => {
      catRegistry.reset();
      Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    });
    const binding = freezeExecutionAccountBinding({
      catId: id,
      catConfig: member,
      workspace: { usesDefaultWorkspace: false },
    });
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => {
      setImmediate(
        () =>
          void emitEvents(proc, [
            { type: 'thread.started', thread_id: 'native-frozen-thread' },
            { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'ok' } },
            { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
          ]),
      );
      return proc;
    });
    const service = new CodexAgentService({
      catId: id,
      model: 'constructor-model',
      cliCommand: process.execPath,
      spawnFn,
      l0CompilerFn: async () => 'FROZEN-IDENTITY',
    });
    catRegistry.reset();
    Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    catRegistry.register(id, { ...member, defaultModel: 'model-b', cli: { ...member.cli, effort: 'high' } });
    const messages = await collect(
      service.invoke('isolated task', {
        executionPreferences: binding.executionPreferences,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      }),
    );
    assert.deepEqual(
      messages.filter((message) => message.type === 'error'),
      [],
    );
    assert.equal(spawnFn.mock.calls.length, 1);
    const args = spawnFn.mock.calls[0].arguments[1];
    assert.equal(args.includes('--model'), Boolean(preferences.model));
    if (preferences.model) assert.equal(args[args.indexOf('--model') + 1], preferences.model);
    assert.equal(
      args.some((arg) => arg.startsWith('model_reasoning_effort=')),
      Boolean(preferences.effort),
    );
    if (preferences.effort) assert.ok(args.includes(`model_reasoning_effort="${preferences.effort}"`));
  });
}

test('PTY preserves frozen native inheritance by omitting empty model and effort flags', async () => {
  const signal = AbortSignal.abort();
  let captured;
  const carrier = new ClaudeInteractivePtyCarrierService({
    catId: 'opus',
    hookSidecarPathOverride: join(tmpdir(), 'frozen-pty-never-started.jsonl'),
    driverFactory: (options) => {
      captured = options.extraArgs;
      return {
        async start() {
          assert.fail('pre-aborted fixture started a native client');
        },
      };
    },
  });
  await collect(
    carrier.invoke('isolated task', {
      signal,
      executionPreferences: { configurationSource: 'native_tool', nativeAuthentication: true, model: '', effort: '' },
    }),
  );
  assert.ok(captured);
  assert.equal(captured.includes('--model'), false);
  assert.equal(captured.includes('--effort'), false);
});
