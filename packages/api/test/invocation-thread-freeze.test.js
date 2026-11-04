import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { freezeExecutionWorkspace } from '../dist/domains/cats/services/agents/invocation/execution-workspace.js';
import {
  invokeSingleCat,
  prepareInvocationExecutionBinding,
} from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ContextEpochOwner } from '../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';

for (const timing of ['before-admission', 'during-workspace', 'during-preferences', 'during-mcp-capture']) {
  test(`cancel ${timing} neither crashes the Host process nor returns a ready admission`, () => {
    const moduleUrl = new URL('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js', import.meta.url)
      .href;
    const registrySetupUrl = new URL('./helpers/setup-cat-registry.js', import.meta.url).href;
    const script = `
      import ${JSON.stringify(registrySetupUrl)};
      import { prepareInvocationExecutionBinding } from ${JSON.stringify(moduleUrl)};
      const controller = new AbortController();
      let reads = 0;
      let rejected = false;
      if (${JSON.stringify(timing)} === 'before-admission') controller.abort();
      await prepareInvocationExecutionBinding({ threadStore: {
        get: async () => { if (${JSON.stringify(timing)} === 'during-workspace') controller.abort(); return null; },
        getMemberEffort: async () => { reads++; if (${JSON.stringify(timing)} === 'during-preferences') controller.abort(); throw new Error('fixture preference read failed'); },
        getMemberSpeed: async () => { reads++; throw new Error('fixture preference read failed'); },
      } }, { catId: 'codex', threadId: 'thread', userId: 'owner', signal: controller.signal,
        service: ${JSON.stringify(timing)} === 'during-mcp-capture' ? { captureInvocationOptions: async () => { controller.abort(); throw new Error('fixture MCP capture failed'); } } : undefined,
      }).catch(error => {
        if (error.name !== 'AbortError') throw error;
        rejected = true;
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      if (['before-admission', 'during-workspace'].includes(${JSON.stringify(timing)}) && reads !== 0) throw new Error('cancelled admission still started preference reads');
      if (!rejected) throw new Error('cancelled admission reported ready');
      console.log('cancelled-safely');
    `;
    const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /cancelled-safely/);
  });
}

test('workspace capture does not retain a mutable in-memory ThreadStore record', async () => {
  const thread = { id: 'thread', projectPath: 'default', memberEffortOverrides: { codex: 'low' } };
  const workspace = await freezeExecutionWorkspace({
    threadStore: { get: () => thread },
    threadId: 'thread',
    userId: 'owner',
    provider: 'openai',
  });
  thread.memberEffortOverrides.codex = 'high';
  assert.equal(workspace.thread.memberEffortOverrides.codex, 'low');
});

for (const preference of ['effort', 'speed']) {
  test(`actual invocation consumes its admitted thread ${preference}, after a later thread edit`, async () => {
    const catId = 'codex-sol';
    const threadStore = new ThreadStore();
    const thread = threadStore.create('owner', 'Frozen thread preferences');
    threadStore.updateMemberEffort(thread.id, catId, 'low');
    threadStore.updateMemberSpeed(thread.id, catId, 'fast');
    const optionsSeen = [];
    const service = {
      supportsToolExecutionPolicy: () => true,
      async *invoke(_prompt, options) {
        optionsSeen.push(options);
        yield { type: 'done', catId, timestamp: Date.now() };
      },
    };
    const deps = {
      registry: {
        create: () => ({ invocationId: 'thread-freeze-invocation', callbackToken: 'fixture-only' }),
        verify: async () => ({ ok: false }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => undefined,
      },
      threadStore,
      apiUrl: 'http://127.0.0.1:13004',
      contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
    };
    const executionBinding = await prepareInvocationExecutionBinding(deps, {
      catId,
      threadId: thread.id,
      userId: 'owner',
      service,
    });
    threadStore.updateMemberEffort(thread.id, catId, 'high');
    threadStore.updateMemberSpeed(thread.id, catId, 'standard');
    const messages = await Array.fromAsync(
      invokeSingleCat(deps, {
        catId,
        service,
        executionBinding,
        threadId: thread.id,
        userId: 'owner',
        prompt: 'isolated task',
        isLastCat: true,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      }),
    );
    assert.deepEqual(
      messages.filter((message) => message.type === 'error'),
      [],
    );
    assert.equal(optionsSeen.length, 1);
    if (preference === 'effort') assert.equal(optionsSeen[0].reasoningEffortOverride, 'low');
    else assert.equal(optionsSeen[0].requestedServiceTier, 'fast');
  });
}
