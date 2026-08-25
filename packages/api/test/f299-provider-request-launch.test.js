import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { ClaudeAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

ensureFakeCliOnPath('claude');
ensureFakeCliOnPath('codex');

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function commit() {
  return {
    requestGenerationId: '4d96dddf-97ca-4c74-9e0a-3f771fd5dfd8',
    generationOrdinal: 1,
    sessionId: 'session-1',
  };
}

test('F299 Claude awaits the recorder and launches from the exact prepared bytes', async () => {
  let recorded;
  let recorderResolved = false;
  let spawned;
  const service = new ClaudeAgentService({
    catId: 'opus-47',
    model: 'claude-test',
    l0CompilerFn: async ({ outPath }) => {
      writeFileSync(outPath, 'CLAUDE-L0', 'utf8');
    },
  });

  await collect(
    service.invoke('message-bytes', {
      systemPrompt: 'append-pack',
      beforeProviderLaunch: async (request) => {
        assert.equal(spawned, undefined);
        recorded = request;
        await Promise.resolve();
        recorderResolved = true;
        return commit();
      },
      spawnCliOverride: (options) => {
        assert.equal(recorderResolved, true);
        spawned = options;
        return (async function* () {
          yield { type: 'result', subtype: 'success' };
        })();
      },
    }),
  );

  assert.equal(recorded.message.body, 'message-bytes');
  assert.deepEqual(
    recorded.nativeInstructions.map((channel) => channel.body),
    ['CLAUDE-L0', 'append-pack'],
  );
  assert.equal(recorded.runtime.carrier, 'print_sdk');
  assert.equal(spawned.stdinInput, recorded.message.body);
});

test('F299 Codex exec_json awaits the recorder and launches from the exact prepared bytes', async () => {
  let recorded;
  let recorderResolved = false;
  let spawned;
  const service = new CodexAgentService({
    carrierMode: 'exec_json',
    model: 'gpt-test',
    l0CompilerFn: async () => 'CODEX-L0',
  });

  await collect(
    service.invoke('codex-message', {
      beforeProviderLaunch: async (request) => {
        assert.equal(spawned, undefined);
        recorded = request;
        await Promise.resolve();
        recorderResolved = true;
        return commit();
      },
      spawnCliOverride: (options) => {
        assert.equal(recorderResolved, true);
        spawned = options;
        return (async function* () {
          yield { type: 'thread.started', thread_id: 'native-thread' };
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
        })();
      },
    }),
  );

  assert.equal(recorded.message.body, 'codex-message');
  assert.match(recorded.nativeInstructions[0].body, /CODEX-L0/);
  assert.equal(recorded.runtime.carrier, 'exec_json');
  assert.equal(spawned.stdinInput, recorded.message.body);
});

test('F299 recorder rejection prevents provider launch', async () => {
  let spawnCount = 0;
  const service = new ClaudeAgentService({
    catId: 'opus-47',
    model: 'claude-test',
    l0CompilerFn: async ({ outPath }) => {
      writeFileSync(outPath, 'CLAUDE-L0', 'utf8');
    },
  });

  const output = await collect(
    service.invoke('must-not-launch', {
      beforeProviderLaunch: async () => {
        throw new Error('durable append failed');
      },
      spawnCliOverride: () => {
        spawnCount += 1;
        return (async function* () {})();
      },
    }),
  );
  assert.equal(spawnCount, 0);
  assert.equal(output[0].type, 'error');
  assert.match(output[0].error, /durable append failed/);
});
