import assert from 'node:assert/strict';
import { collectiveEventSourceIdentity } from '@cat-cafe/shared';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import type { InvocationRecord } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { CollectiveCurrentContext } from '../src/domains/plugin/builtin-runtime/collective-current-context.js';
import { collectiveSource } from '../src/domains/plugin/builtin-runtime/collective-ingress-routing.js';
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

/** Real Service HTTP/Connector/Host authority/dispatcher; OAuth, model and Host stores are explicit fixtures. */
export async function fixture(options: { now?: () => number; expiresAt?: string } = {}) {
  const world = await createWorld({ now: options.now });
  const cafe = world.operator;
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const threads = new ThreadStore();
  const endpoint = threads.create(cafe.ownerUserId, 'Public channel');
  threads.addParticipants(endpoint.id, [CAT]);
  const participationRevision = await world.declareCats(cafe, [CAT], { threadId: endpoint.id });
  await grantAndAdopt(
    world,
    cafe,
    options.expiresAt
      ? {
          grants: [
            {
              grantRef: 'grant-guides',
              catIds: [CAT],
              channelIds: ['general'],
              requestingHumanIds: 'channel_members',
              requestKinds: ['guide'],
              expiresAt: options.expiresAt,
            },
          ],
        }
      : {},
  );
  const authority = new CollectiveWorkAuthority({
    messageStore: messages,
    taskStore: tasks,
    standingGrant: (source, catId) => resolveCollectiveStandingGrant(cafe.connector, source, catId),
    resolveWorkThread: (source, catId) => resolveCollectiveWorkThread(threads, tasks, source, catId),
  });
  const context = new CollectiveCurrentContext({
    connector: () => cafe.connector,
    messageStore: messages,
    threadStore: threads,
    workAuthority: authority,
  });
  const queue = new InvocationQueue();
  const dispatcher = new CollectiveWorkDispatcher({
    context: () => context,
    messageStore: messages,
    threadStore: threads,
    invocationQueue: queue,
    queueProcessor: {
      async processNext() {
        return { started: false };
      },
    },
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
        idempotencyKey: `test-ingress:${event.eventId}`,
      })
    ).message;
  };
  const request = await postNaturalRequest(
    world,
    world.wulang,
    cafe,
    CAT,
    'Matter A: build guide',
    participationRevision,
  );
  const work = await catAccepts(world, cafe, request);
  assert.ok(work.assignmentEventId);
  const source = await persist(work.assignmentEventId);
  const firstDispatch = await admission.admit(source, CAT);
  assert.ok(firstDispatch);
  const task = (await tasks.listByKind('work'))[0];
  assert.ok(task?.entrustedWork);
  const authFor = async (messageId: string) => {
    const carrier = (await messages.getById(messageId))?.extra?.collectiveWorkInvocationV1;
    assert.ok(carrier);
    const currentTask = await tasks.get(carrier.taskId);
    assert.ok(currentTask);
    const input = {
      userId: cafe.ownerUserId,
      threadId: currentTask.threadId,
      catId: CAT,
      ownerAuthProvenance: 'unknown' as const,
      originTriggerMessageId: messageId,
    };
    const binding = await context.resolvePrivate(input, 'admission');
    assert.ok(binding);
    return {
      ...input,
      invocationId: world.startTurn(CAT),
      callbackToken: 'fixture-secret',
      collectiveWorkBinding: { ...carrier, sourceRef: binding.sourceRef, authorityRef: binding.work.authorityRef },
    } as InvocationRecord;
  };
  const firstAuth = await authFor(firstDispatch.messageId);
  const continueWork = async (body: string, revision = participationRevision) => {
    const feedback = await world.store.postHumanMessage(world.wulang.sessionToken, {
      ...world.coordinates,
      clientEventId: `feedback-${body}`,
      target: { kind: 'message', eventId: work.assignmentEventId! },
      replyToEventId: work.assignmentEventId!,
      location: { channelId: 'general', rootEventId: work.sourceEventId },
      recipient: {
        kind: 'agent',
        humanId: cafe.humanId,
        connectionId: cafe.connectionId,
        agentId: CAT,
        participationRevision: revision,
      },
      body,
    });
    const identity = collectiveEventSourceIdentity(feedback);
    assert.ok(identity);
    const current = workOf(world, work.workId);
    const result = await cafe.connector.continueWork(identity, world.agent(CAT, world.startTurn(CAT)), {
      workId: work.workId,
      expectedRevision: current.revision,
      kind: 'resume',
      grantRef: 'grant-guides',
      grantRevision: await grantRevisionOf(cafe),
      requestKind: 'guide',
    });
    assert.ok(result.executionAuthority);
    return { work: result, source: await persist(result.executionAuthority.eventId) };
  };
  return {
    world,
    cafe,
    work,
    task,
    tasks,
    messages,
    threads,
    endpoint,
    authority,
    context,
    queue,
    admission,
    dispatcher,
    firstAuth,
    continueWork,
    authFor,
    persist,
  };
}
