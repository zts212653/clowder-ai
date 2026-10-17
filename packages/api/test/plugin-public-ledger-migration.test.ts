import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertQueueLedgerEntry,
  queueLedgerAdmissionsMatch,
} from '../src/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { createQueueLedgerAdmission } from '../src/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.js';

const carrier = {
  version: 1,
  admissionId: 'a',
  sourceMessageId: 'source',
  sourcePluginRevision: 1,
  pluginInstanceId: 'instance',
  packageDigest: 'digest',
  lifecycleRevision: 1,
  grantRevision: 1,
  contributionId: 'native',
  actionMethods: ['native.read'],
  targetCatId: 'codex',
  authorityRef: 'ref',
  authorityRevision: 'r1',
};
function row() {
  return createQueueLedgerAdmission({
    sourceId: 'source',
    messageId: 'source',
    threadId: 'thread',
    owner: { kind: 'user', userId: 'owner' },
    kind: 'conversation_input',
    from: { kind: 'plugin', instanceId: 'instance' },
    targetCatIds: ['codex'],
    content: 'public body',
    intent: 'execute',
    ownerAuthProvenance: 'unknown',
    autoExecute: true,
    enqueuedAt: 1000,
    pluginPublicInvocation: carrier,
  })[0]!;
}
test('public Queue admission preserves detached carrier and immutable identity', () => {
  const a = row();
  assertQueueLedgerEntry(a);
  const b = structuredClone(a);
  b.execution.pluginPublicInvocation!.authorityRevision = 'r2';
  assert.equal(queueLedgerAdmissionsMatch(a, b), false);
  assert.notEqual(a.execution.pluginPublicInvocation, carrier);
});
test('public Queue admission rejects widened sender, target, source and owner authority', () => {
  const changes = [
    (a: any) => {
      a.from = { kind: 'user', userId: 'owner' };
    },
    (a: any) => {
      a.targets = ['opus'];
    },
    (a: any) => {
      a.execution.ownerAuthProvenance = 'strict';
    },
    (a: any) => {
      a.payload.messageId = 'other';
    },
    (a: any) => {
      a.execution.pluginPublicInvocation.actionMethods = [];
    },
  ];
  for (const change of changes) {
    const a = row();
    change(a);
    assert.throws(() => assertQueueLedgerEntry(a));
  }
});

import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { readDurablePublicInvocationCurrent } from '../src/domains/plugin/carrier/public-invocation-currentness.js';
import { createPluginPublicInvocationHost } from '../src/domains/plugin/host-surface/plugin-public-invocation-host.js';
import { projectPluginQueueProgress } from '../src/domains/plugin/host-surface/plugin-source-progress.js';

function fixture() {
  const messages = new MessageStore();
  const source = messages.append({
    userId: 'owner',
    threadId: 'thread',
    from: { kind: 'plugin', instanceId: 'instance' },
    content: 'external source',
    mentions: [],
    timestamp: 1000,
    extra: {
      pluginMessage: {
        instanceId: 'instance',
        revision: 1,
        presentation: { connector: 'fixture', label: 'Fixture', icon: 'message' },
        provenance: { origin: { kind: 'plugin', instanceId: 'instance' }, epistemicStatus: 'observation' },
        elements: [],
        appendOps: [],
      },
    },
  });
  const queue = new InvocationQueue();
  let resumes = 0;
  const threads = { get: async () => ({ id: 'thread', createdBy: 'owner', participants: ['codex'] }) };
  const host = createPluginPublicInvocationHost({
    pluginInstanceId: 'instance',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    grantRevision: 1,
    ownerUserId: 'owner',
    manifest: {
      features: [
        {
          id: 'f',
          capabilities: ['thread.readContent', 'messaging.send'],
          contributions: [{ type: 'mcp', id: 'native' }],
        },
      ],
      contributions: [{ type: 'mcp', id: 'native', actions: [{ method: 'native.read' }] }],
    } as any,
    effectiveGrants: ['thread.readContent', 'messaging.send'],
    messages,
    threads: threads as any,
    services: {
      queue,
      resume: async () => {
        resumes++;
      },
    },
    assertCurrent: async () => {},
    verify: async (_instance, _carrier, context) => {
      await context.assertCurrent();
      return { current: true };
    },
  });
  const input = {
    messageRef: `message:${source.id}` as const,
    targetCatId: 'codex',
    native: { contributionId: 'native', methods: ['native.read'] },
    authority: { ref: 'ref', revision: 'r1' },
  };
  return { messages, source, queue, threads, host, input, resumes: () => resumes };
}
test('actual MessageStore and QueueLedger admit exactly once and reject changed public authority', async () => {
  const f = fixture();
  const first = await f.host.enqueue(f.input);
  const again = await f.host.enqueue(f.input);
  assert.equal(first.entryId, again.entryId);
  assert.equal(first.status, 'queued');
  const entry = await f.queue.getDurableEntry('thread', first.entryId);
  assert.ok(entry);
  assert.equal(entry.execution.pluginPublicInvocation?.sourceMessageId, f.source.id);
  assert.equal(f.queue.list('thread', 'owner').length, 1);
  await assert.rejects(f.host.enqueue({ ...f.input, authority: { ref: 'ref', revision: 'r2' } }));
  const progress = await projectPluginQueueProgress(f.messages.getById(f.source.id)!, 'owner', f.messages, f.queue);
  assert.equal(progress?.status, 'queued');
  assert.deepEqual(progress?.allTargetCats, ['codex']);
});
test('History child binding fences the running public caller and cannot replay a settled delivery', async () => {
  const f = fixture();
  const receipt = await f.host.enqueue(f.input);
  const entry = (await f.queue.getDurableEntry('thread', receipt.entryId))!;
  const response = f.messages.append({
    userId: 'owner',
    threadId: 'thread',
    from: { kind: 'agent', catId: 'codex' },
    content: '',
    mentions: [],
    timestamp: 1100,
    lifecycle: {
      kind: 'response',
      orderKey: '1100:child',
      invocationId: 'child',
      targetId: 'codex',
      inputEntryIds: [receipt.entryId],
      inputMessageIds: [f.source.id],
      status: 'processing',
      startedAt: 1100,
    },
  });
  const source = f.messages.getById(f.source.id)!;
  assert.equal(
    f.messages.advanceLifecycleInputDispatch(source.id, {
      orderKey: source.lifecycle!.orderKey,
      targetId: 'codex',
      phase: 'dispatched',
      statusMessageId: response.id,
      dispatchedAt: 1100,
    }).kind,
    'applied',
  );
  const args = [
    'instance',
    entry.execution.pluginPublicInvocation!,
    { entryId: receipt.entryId, userId: 'owner', threadId: 'thread', targetCatId: 'codex', invocationId: 'child' },
    { signal: new AbortController().signal, assertCurrent: async () => {} },
    { ownerUserId: 'owner', messageStore: f.messages, threadStore: f.threads, queue: f.queue },
    async () => ({ current: true as const }),
  ] as const;
  const read = await readDurablePublicInvocationCurrent(
    ...(args as Parameters<typeof readDurablePublicInvocationCurrent>),
  );
  assert.equal(read.content, 'external source');
  await assert.rejects(
    readDurablePublicInvocationCurrent(
      ...([...args.slice(0, 2), { ...args[2], invocationId: 'other' }, ...args.slice(3)] as Parameters<
        typeof readDurablePublicInvocationCurrent
      >),
    ),
  );
  const before = f.resumes();
  assert.equal((await f.host.enqueue(f.input)).status, 'processing');
  assert.equal(f.resumes(), before);
  assert.equal(
    f.messages.advanceLifecycleInputDispatch(source.id, {
      orderKey: source.lifecycle!.orderKey,
      targetId: 'codex',
      phase: 'settled',
      statusMessageId: response.id,
      dispatchedAt: 1100,
    }).kind,
    'applied',
  );
  await assert.rejects(
    readDurablePublicInvocationCurrent(...(args as Parameters<typeof readDurablePublicInvocationCurrent>)),
  );
  await f.host.enqueue(f.input);
  assert.equal(f.resumes(), before, 'history receipt cannot schedule another child');
});

test('public input is not exposed or adopted by an ordinary body reader', async () => {
  const f = fixture();
  const receipt = await f.host.enqueue(f.input);
  assert.deepEqual(f.queue.getQueuedBodyMessagesForCat('thread', 'owner', 'codex'), []);
  assert.equal(await f.queue.claimExactExposureDurable('thread', 'owner', receipt.entryId, 'codex', f.source.id), null);
  assert.equal((await f.queue.getDurableEntry('thread', receipt.entryId))?.status, 'queued');
});
