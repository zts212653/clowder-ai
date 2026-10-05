import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { collectiveEventSourceIdentity } from '@cat-cafe/shared';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import type { InvocationRecord } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { type IMessageStore, MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { CollectiveCurrentContext } from '../src/domains/plugin/builtin-runtime/collective-current-context.js';
import {
  collectiveSource,
  ingressIdempotencyKey,
} from '../src/domains/plugin/builtin-runtime/collective-ingress-routing.js';
import { resolveCollectiveStandingGrant } from '../src/domains/plugin/builtin-runtime/collective-standing-grant.js';
import { CollectiveWorkAdmission } from '../src/domains/plugin/builtin-runtime/collective-work/collective-work-admission.js';
import { CollectiveWorkAuthority } from '../src/domains/plugin/builtin-runtime/collective-work-authority.js';
import { CollectiveWorkDispatcher } from '../src/domains/plugin/builtin-runtime/collective-work-dispatcher.js';
import { resolveCollectiveWorkThread } from '../src/domains/plugin/builtin-runtime/collective-work-thread.js';
import {
  catAccepts,
  createWorld,
  grantAndAdopt,
  grantRevisionOf,
  postNaturalRequest,
  workOf,
} from './f290-communication-validation.harness.js';
import { CAT } from './f290-communication-validation.host.js';

/** Real Service HTTP/Connector/Host, deferred first admission; no model or production data. */
export async function bootstrapFixture({ persistBirth = true } = {}) {
  const world = await createWorld();
  const cafe = world.operator;
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const threads = new ThreadStore();
  const endpoint = threads.create(cafe.ownerUserId, 'Public channel');
  let participationRevision = await world.declareCats(cafe, [CAT], { threadId: endpoint.id });
  await grantAndAdopt(world, cafe);
  const hooks: { beforeAppend?: (input: Parameters<IMessageStore['appendIdempotent']>[0]) => Promise<void> } = {};
  const messageFacade = {
    getById: messages.getById.bind(messages),
    getByIdempotencyKey: messages.getByIdempotencyKey.bind(messages),
    appendIdempotent: async (input: Parameters<IMessageStore['appendIdempotent']>[0]) => {
      await hooks.beforeAppend?.(input);
      return messages.appendIdempotent(input);
    },
  };
  const authority = new CollectiveWorkAuthority({
    messageStore: messageFacade,
    taskStore: tasks,
    standingGrant: (source, catId) => resolveCollectiveStandingGrant(cafe.connector, source, catId),
    resolveWorkThread: (source, catId) => resolveCollectiveWorkThread(threads, tasks, source, catId),
  });
  const context = new CollectiveCurrentContext({
    connector: () => cafe.connector,
    messageStore: messageFacade,
    threadStore: threads,
    workAuthority: authority,
  });
  const queue = new InvocationQueue();
  const dispatcher = new CollectiveWorkDispatcher({
    context: () => context,
    messageStore: messages,
    threadStore: threads,
    invocationQueue: queue,
    queueProcessor: { async processNext() {} },
  });
  const admission = new CollectiveWorkAdmission({ connector: () => cafe.connector, authority, tasks, dispatcher });
  const persist = async (eventId: string) => {
    await cafe.connector.sync(cafe.connectionId);
    const event = (await cafe.connector.listInbox(cafe.connectionId)).find(
      (item) => item.event.eventId === eventId,
    )?.event;
    assert.ok(event);
    return (
      await messages.appendIdempotent({
        userId: cafe.ownerUserId,
        threadId: endpoint.id,
        catId: null,
        mentions: [],
        timestamp: Date.parse(event.acceptedAt),
        content: event.body,
        source: collectiveSource(event),
        idempotencyKey: ingressIdempotencyKey(event),
      })
    ).message;
  };
  const request = await postNaturalRequest(
    world,
    world.wulang,
    cafe,
    CAT,
    'Matter A: late Host admission',
    participationRevision,
  );
  const work = await catAccepts(world, cafe, request);
  assert.ok(work.assignmentEventId);
  const birth = persistBirth ? await persist(work.assignmentEventId) : undefined;
  const regrant = async () => {
    await world.declareCats(cafe, [], { threadId: endpoint.id });
    participationRevision = await world.declareCats(cafe, [CAT], { threadId: endpoint.id });
    await grantAndAdopt(world, cafe);
  };
  const continueWork = async (body: string) => {
    const event = await world.store.postHumanMessage(world.wulang.sessionToken, {
      ...world.coordinates,
      clientEventId: randomUUID(),
      replyToEventId: work.assignmentEventId,
      target: { kind: 'message', eventId: work.assignmentEventId },
      location: { channelId: 'general', rootEventId: work.sourceEventId },
      recipient: {
        kind: 'agent',
        humanId: cafe.humanId,
        connectionId: cafe.connectionId,
        agentId: CAT,
        participationRevision,
      },
      body,
    });
    const source = collectiveEventSourceIdentity(event);
    assert.ok(source);
    const current = workOf(world, work.workId);
    const continued = await cafe.connector.continueWork(source, world.agent(CAT, world.startTurn(CAT)), {
      workId: work.workId,
      expectedRevision: current.revision,
      kind: 'resume',
      grantRef: 'grant-guides',
      grantRevision: await grantRevisionOf(cafe),
      requestKind: 'guide',
    });
    assert.ok(continued.executionAuthority);
    return { work: continued, source: await persist(continued.executionAuthority.eventId) };
  };
  const authFor = async (messageId: string) => {
    const trigger = await messages.getById(messageId);
    assert.ok(trigger?.extra?.collectiveWorkInvocationV1);
    const task = await tasks.get(trigger.extra.collectiveWorkInvocationV1.taskId);
    assert.ok(task);
    const input = {
      userId: cafe.ownerUserId,
      threadId: task.threadId,
      catId: CAT,
      ownerAuthProvenance: 'unknown' as const,
      originTriggerMessageId: messageId,
    };
    const binding = await context.resolvePrivate(input, 'admission');
    assert.ok(binding);
    return {
      ...input,
      invocationId: world.startTurn(CAT),
      callbackToken: 'bootstrap-fixture-secret',
      collectiveWorkBinding: {
        ...trigger.extra.collectiveWorkInvocationV1,
        sourceRef: binding.sourceRef,
        authorityRef: binding.work.authorityRef,
      },
    } as InvocationRecord;
  };
  return {
    world,
    cafe,
    messages,
    tasks,
    threads,
    endpoint,
    authority,
    context,
    queue,
    admission,
    dispatcher,
    persist,
    work,
    birth,
    regrant,
    continueWork,
    authFor,
    hooks,
  };
}
