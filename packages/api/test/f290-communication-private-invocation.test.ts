import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { CollectivePrivateWorkRefusalError } from '../src/domains/cats/services/agents/invocation/collective-private-refusal.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  type InvocationDeps,
  invokeSingleCat,
} from '../src/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import type { AgentService, AgentServiceOptions } from '../src/domains/cats/services/types.js';

test('real invocation composition replaces ambient private history with exact Task/source bytes and registers scoped unknown authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'f290-invocation-scope-'));
  const previousData = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = directory;
  const catId = createCatId('codex-sol');
  const registry = new InvocationRegistry();
  registry.setCollectiveWorkAuthorityValidator(async () => {});
  const messages = new MessageStore();
  const origin = messages.append({
    userId: 'owner',
    threadId: 'private-A',
    catId: null,
    mentions: [catId],
    content: 'EXACT_TASK_RELAY_CANARY',
    timestamp: 1,
    extra: {
      collectiveWorkInvocationV1: { v: 1, taskId: 'A', observedRevision: 1, resultRevision: 1, executionRevision: 2 },
    },
  });
  let launched: { prompt: string; options?: AgentServiceOptions } | undefined;
  const service: AgentService = {
    supportsToolExecutionPolicy: (policy) => policy.mode === 'collective_work',
    async *invoke(prompt, options) {
      launched = { prompt, options };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
  const source = { serviceInstanceId: 'service', collectiveId: 'world', location: { channelId: 'channel' } };
  const work = {
    sourceRef: 'message:current-A',
    grant: { source },
    context: {
      events: [],
      source: {
        ...source,
        eventId: 'current-A',
        sequence: 1,
        actor: { type: 'human' },
        body: 'CURRENT_PUBLIC_A_CANARY',
      },
    },
    work: {
      task: { id: 'A', title: 'Guide A', why: 'Write A' },
      revision: 1,
      resultRevision: 1,
      authorityRef: 'message:admission-A',
      executionRevision: 2,
      executionRef: 'message:admission-A',
    },
  };
  const deps = {
    registry,
    messageStore: messages,
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3182',
    collectiveContext: () => ({ resolvePrivate: async () => work }),
    sessionManager: {
      async get() {},
      async getOrCreate() {
        return {};
      },
      async store() {},
      async delete() {},
      resolveWorkingDirectory() {
        return '/UNRELATED_OWNER_REPO';
      },
    },
  } as unknown as InvocationDeps;
  try {
    const events = [];
    for await (const event of invokeSingleCat(deps, {
      catId,
      service,
      userId: 'owner',
      threadId: 'private-A',
      isLastCat: true,
      executionScope: 'collective-work',
      a2aTriggerMessageId: origin.id,
      ownerAuthProvenance: 'strict',
      prompt: 'UNRELATED_PRIVATE_HISTORY_CANARY',
    }))
      events.push(event);
    assert.ok(launched, JSON.stringify(events));
    assert.match(launched.prompt, /CURRENT_PUBLIC_A_CANARY/);
    assert.match(launched.prompt, /EXACT_TASK_RELAY_CANARY/);
    assert.doesNotMatch(launched.prompt, /UNRELATED_PRIVATE_HISTORY_CANARY/);
    const policy = launched.options?.toolExecutionPolicy;
    assert.equal(policy?.mode, 'collective_work');
    assert.ok(launched.options?.workingDirectory?.startsWith(await realpath(directory)));
    assert.equal(launched.options?.sessionId, undefined);
    const record = await registry.getRecord(launched.options?.invocationId ?? '');
    assert.equal(record?.ownerAuthProvenance, 'unknown');
    assert.equal(record?.collectiveWorkBinding?.taskId, 'A');
    assert.equal(record?.collectiveWorkBinding?.executionRevision, 2);
    await assert.rejects(
      async () => {
        for await (const _event of invokeSingleCat(deps, {
          catId,
          service,
          userId: 'owner',
          threadId: 'private-A',
          isLastCat: true,
          executionScope: 'collective-work',
          a2aTriggerMessageId: origin.id,
          prompt: 'READ_ONLY_REPLAY',
          toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
        })) {
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof CollectivePrivateWorkRefusalError);
        assert.equal(error.reason, 'private_policy_conflict');
        return true;
      },
    );
  } finally {
    if (previousData === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previousData;
    await rm(directory, { recursive: true, force: true });
  }
});
