/** Codex is the only provider opted into interrupt-first stall termination. */

import assert from 'node:assert/strict';
import './helpers/setup-cat-registry.js';
import { test } from 'node:test';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const { CodexAgentService } = await import('../dist/domains/cats/services/agents/providers/CodexAgentService.js');

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

test('CodexAgentService adds interrupt-first without mutating the caller liveness config', async () => {
  const seen = [];
  const callerConfig = { stallAutoKill: true, stallWarningMs: 420_000 };
  const service = new CodexAgentService({
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.3-codex',
  });

  await collect(
    service.invoke('test stall policy', {
      livenessProbe: callerConfig,
      spawnCliOverride: async function* (options) {
        seen.push(options);
        yield { type: 'thread.started', thread_id: 'thread-stall-policy' };
        yield { type: 'turn.completed' };
      },
    }),
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0].livenessProbe.stallTerminationMode, 'interrupt-first');
  assert.deepEqual(callerConfig, { stallAutoKill: true, stallWarningMs: 420_000 });
});
