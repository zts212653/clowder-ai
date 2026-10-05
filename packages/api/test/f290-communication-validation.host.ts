/**
 * F290 communication validation — a Café Host assembled from the PRODUCTION classes (L2).
 *
 * Production: CollectiveIngressDispatcher, CollectiveWorkAdmission, CollectiveWorkAuthority (with the same
 * standingGrant / resolveWorkThread wiring as api/src/index.ts), CollectiveCurrentContext, CollectiveWorkDispatcher,
 * both reconcilers, InvocationQueue, QueueProcessor, InvocationTracker, InvocationRegistry, and the production Cat
 * verifier (via the harness Connector). Thread/Message/Task stores are the in-memory implementations.
 *
 * Fixtures, stated explicitly:
 *  - The MODEL. `router.routeExecution` is the only place a model would run. Here it is a scripted Cat that holds a
 *    `running` turn record and calls the same production CollectiveCurrentContext methods a real Cat's MCP callbacks
 *    reach (`current`, `acceptWork`, `reply`). It is NOT a real model and NOT invokeSingleCat; the
 *    `resolvePrivate(..., 'admission')` check that invokeSingleCat performs first is repeated here.
 *  - The invocation record store and socket manager are inert doubles.
 *  - `api/src/index.ts` itself is not started; its closures are mirrored line for line below.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { type CatId, catRegistry, collectiveSourceIdentitySchema, createCatId, type TaskItem } from '@cat-cafe/shared';
import { loadCatConfig, toAllCatConfigs } from '../src/config/cat-config-loader.js';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueuedMessageCustodyCoordinator } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../src/domains/cats/services/agents/invocation/QueueProcessor.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { F232PreparedArtifactReader } from '../src/domains/growing/F232PreparedArtifactReader.js';
import { CollectiveCurrentContext } from '../src/domains/plugin/builtin-runtime/collective-current-context.js';
import { CollectiveIngressDispatcher } from '../src/domains/plugin/builtin-runtime/collective-ingress-dispatcher.js';
import { resolveCollectiveStandingGrant } from '../src/domains/plugin/builtin-runtime/collective-standing-grant.js';
import { CollectiveWorkAdmission } from '../src/domains/plugin/builtin-runtime/collective-work/collective-work-admission.js';
import { CollectiveWorkAuthority } from '../src/domains/plugin/builtin-runtime/collective-work-authority.js';
import { CollectiveWorkDispatcher } from '../src/domains/plugin/builtin-runtime/collective-work-dispatcher.js';
import { CollectiveWorkResultReconciler } from '../src/domains/plugin/builtin-runtime/collective-work-result-reconciler.js';
import { CollectiveWorkRevisionReconciler } from '../src/domains/plugin/builtin-runtime/collective-work-revision-reconciler.js';
import { resolveCollectiveWorkThread } from '../src/domains/plugin/builtin-runtime/collective-work-thread.js';
import type { Cafe, World } from './f290-communication-validation.harness.js';

// Source-level registry from the template (no dist build needed).
const configs = toAllCatConfigs(loadCatConfig(fileURLToPath(new URL('../../../cat-template.json', import.meta.url))));
for (const [id, config] of Object.entries(configs)) if (!catRegistry.has(id)) catRegistry.register(id, config);

export const CAT = createCatId('codex-sol');

export interface HostRun {
  readonly scope: 'public' | 'private';
  readonly threadId: string;
  readonly taskId?: string;
  readonly resultRevision?: number;
  outcome: 'completed' | 'refused';
  error?: string;
}

const noop = () => {};
/** Collects QueueProcessor warnings/errors so a stuck Host explains itself. */
export const hostLogs: string[] = [];
const brief = (value: unknown) => {
  const candidate = value as { err?: { message?: string; code?: string }; message?: string } | undefined;
  return candidate?.err
    ? `${candidate.err.code ?? ''} ${candidate.err.message}`
    : String(candidate?.message ?? JSON.stringify(value)).slice(0, 200);
};
const log = {
  info: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
  warn: (obj: unknown, message?: string) => void hostLogs.push(`warn ${message ?? ''} ${brief(obj)}`),
  error: (obj: unknown, message?: string) => void hostLogs.push(`error ${message ?? ''} ${brief(obj)}`),
  child: () => log,
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 15_000) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out: ${message}`);
    await sleep(20);
  }
}

export async function createHost(world: World, cafe: Cafe) {
  const userId = cafe.ownerUserId;
  const threads = new ThreadStore();
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const endpoint = threads.create(userId, 'Collective public participation');
  threads.addParticipants(endpoint.id, [CAT]);
  const participationRevision = await world.declareCats(cafe, [CAT], { threadId: endpoint.id });

  const authority = new CollectiveWorkAuthority({
    messageStore: messages,
    taskStore: tasks,
    resolveWorkThread: (source, catId) => resolveCollectiveWorkThread(threads, tasks, source, catId),
    standingGrant: (source, catId) => resolveCollectiveStandingGrant(cafe.connector, source, catId),
  });
  const context = new CollectiveCurrentContext({
    connector: () => cafe.connector,
    messageStore: messages,
    threadStore: threads,
    workAuthority: authority,
    artifactReader: new F232PreparedArtifactReader({ messages }),
  });
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  const registry = new InvocationRegistry();
  const runs: HostRun[] = [];
  let active = 0;
  const heldThreads = new Set<string>();
  const hooks: {
    afterTaskAdmitted?: () => Promise<void>;
    holdPrivateRun?: (task: TaskItem) => Promise<void> | undefined;
  } = {};

  const runPublic = async (trigger: NonNullable<Awaited<ReturnType<typeof messages.getById>>>, catId: CatId) => {
    const source = collectiveSourceIdentitySchema.parse(trigger.source?.meta?.participation);
    const run: HostRun = { scope: 'public', threadId: trigger.threadId, outcome: 'completed' };
    runs.push(run);
    const created = await registry.create(
      userId,
      catId,
      trigger.threadId,
      undefined,
      undefined,
      { mode: 'collective_participation' },
      trigger.id,
      'unknown',
      undefined,
      { kind: 'collective-participation', originTriggerMessageId: trigger.id, source },
    );
    const verified = await registry.verify(created.invocationId, created.callbackToken);
    if (!verified.ok) throw new Error('public invocation record was not verifiable');
    const auth = verified.record;
    world.turns.set(auth.invocationId, { catId, status: 'running' });
    try {
      const current = await context.current(auth);
      // The scripted Cat follows the public skill: accept only with an adopted, automatic delegation.
      const decision = current.workDecision;
      const grant =
        decision?.decisionMode === 'automatic' && decision.delegationState === 'adopted'
          ? decision.grants.find((candidate) => candidate.requestKinds.includes('guide'))
          : undefined;
      if (!grant) return;
      await context.acceptWork(auth, current.contextRef, {
        grantRef: grant.grantRef,
        grantRevision: grant.grantRevision,
        requestKind: 'guide',
        title: 'Newcomer guide',
        intendedOutcome: current.request.body,
      });
    } catch (error) {
      run.outcome = 'refused';
      run.error = describe(error);
      throw error;
    } finally {
      world.endTurn(auth.invocationId);
    }
  };

  const runPrivate = async (trigger: NonNullable<Awaited<ReturnType<typeof messages.getById>>>, catId: CatId) => {
    const carrier = trigger.extra?.collectiveWorkInvocationV1;
    const run: HostRun = {
      scope: 'private',
      threadId: trigger.threadId,
      ...(carrier ? { taskId: carrier.taskId, resultRevision: carrier.resultRevision } : {}),
      outcome: 'completed',
    };
    runs.push(run);
    try {
      // invokeSingleCat's first act for an owner-admitted Work: no admission, no execution.
      const binding = await context.resolvePrivate(
        {
          userId,
          threadId: trigger.threadId,
          catId,
          ownerAuthProvenance: 'unknown',
          originTriggerMessageId: trigger.id,
        },
        'admission',
      );
      if (!binding || !carrier) throw new Error('collective_owner_admission_unavailable');
      const hold = hooks.holdPrivateRun?.(binding.work.task);
      if (hold) {
        heldThreads.add(trigger.threadId);
        active--;
        await hold;
        active++;
        heldThreads.delete(trigger.threadId);
      }
      const created = await registry.create(
        userId,
        catId,
        trigger.threadId,
        undefined,
        undefined,
        undefined,
        trigger.id,
        'unknown',
        undefined,
        undefined,
        {
          v: 1,
          taskId: binding.work.task.id,
          observedRevision: carrier.observedRevision,
          resultRevision: carrier.resultRevision,
          executionRevision: carrier.executionRevision ?? 1,
          ...(carrier.executionRef ? { executionRef: carrier.executionRef } : {}),
          sourceRef: binding.sourceRef,
          authorityRef: binding.work.authorityRef,
        },
      );
      const verified = await registry.verify(created.invocationId, created.callbackToken);
      if (!verified.ok) throw new Error('private invocation record was not verifiable');
      const auth = verified.record;
      world.turns.set(auth.invocationId, { catId, status: 'running' });
      try {
        const current = await context.current(auth);
        await context.reply(
          auth,
          current.returnRef,
          current.replyOperationRef,
          `Result v${carrier.resultRevision} for ${binding.work.task.title}`,
        );
      } finally {
        world.endTurn(auth.invocationId);
      }
    } catch (error) {
      run.outcome = 'refused';
      run.error = describe(error);
      throw error;
    }
  };

  const router = {
    async *routeExecution(
      routedUserId: string,
      _content: string,
      routedThreadId: string,
      messageId: string | null,
      targetCats: string[],
      _intent: { intent: string },
      options?: Record<string, unknown>,
    ) {
      const catId = createCatId(targetCats[0] ?? CAT);
      const trigger = messageId ? await messages.getById(messageId) : null;
      active++;
      try {
        // Like invokeSingleCat, expose the exact queued prompt bodies before the provider starts: the real
        // QueueProcessor refuses to count a success that never exposed its Queue body.
        const exposed = options?.onPromptMessagesExposed as
          | ((input: {
              threadId: string;
              userId: string;
              catId: string;
              invocationId: string;
              messageIds: readonly string[];
              seenAt: number;
            }) => Promise<unknown> | unknown)
          | undefined;
        await exposed?.({
          threadId: routedThreadId,
          userId: routedUserId,
          catId,
          invocationId: String(options?.parentInvocationId ?? ''),
          messageIds: (options?.persistedPromptMessageIds as string[] | undefined) ?? (messageId ? [messageId] : []),
          seenAt: Date.now(),
        });
        if (trigger && options?.executionScope === 'collective-participation') await runPublic(trigger, catId);
        else if (trigger && options?.executionScope === 'collective-work') await runPrivate(trigger, catId);
      } finally {
        active--;
      }
      yield { type: 'text', catId, content: 'ok', timestamp: Date.now() };
      yield { type: 'done', catId, content: '', timestamp: Date.now() };
    },
    async ackCollectedCursors() {},
  };
  const invocationRecords = new Map<string, Record<string, unknown>>();
  const queueProcessor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    invocationRecordStore: {
      async create(input) {
        const invocationId = `inv-${randomUUID()}`;
        invocationRecords.set(invocationId, { id: invocationId, ...input, status: 'queued' });
        return { outcome: 'created', invocationId };
      },
      async get(id) {
        return (invocationRecords.get(id) as never) ?? null;
      },
      async update(id, data) {
        const record = invocationRecords.get(id);
        if (!record) return null;
        const { expectedStatus, ...patch } = data as { expectedStatus?: string } & Record<string, unknown>;
        if (expectedStatus !== undefined && record.status !== expectedStatus) return null;
        const updated = { ...record, ...patch };
        invocationRecords.set(id, updated);
        return updated;
      },
    },
    router: router as never,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    messageStore: messages,
    queueCustodyCoordinator: new QueuedMessageCustodyCoordinator({ messageStore: messages }),
    log,
  });
  const dispatcher = new CollectiveWorkDispatcher({
    context: () => context,
    messageStore: messages,
    threadStore: threads,
    invocationQueue: queue,
    queueProcessor,
  });
  const admission = new CollectiveWorkAdmission({
    connector: () => cafe.connector,
    authority,
    tasks,
    dispatcher,
  });
  const originalAdmitStanding = authority.admitStanding.bind(authority);
  authority.admitStanding = async (source, catId) => {
    const result = await originalAdmitStanding(source, catId);
    await hooks.afterTaskAdmitted?.();
    return result;
  };
  const revisionReconciler = new CollectiveWorkRevisionReconciler({ messages, tasks, dispatcher });
  const resultReconciler = new CollectiveWorkResultReconciler({ messages, tasks });
  const connectorPort = {
    getProjection: (id: string) => cafe.connector.getProjection(id),
    getHostRoute: (id: string) => cafe.connector.getHostRoute(id),
    listInboxForRouting: (id: string) => cafe.connector.listInboxForRouting(id),
    beginInboxRouting: (...args: Parameters<typeof cafe.connector.beginInboxRouting>) =>
      cafe.connector.beginInboxRouting(...args),
    completeInboxRouting: (...args: Parameters<typeof cafe.connector.completeInboxRouting>) =>
      cafe.connector.completeInboxRouting(...args),
    failInboxRouting: (...args: Parameters<typeof cafe.connector.failInboxRouting>) =>
      cafe.connector.failInboxRouting(...args),
    readParticipationContext: (...args: Parameters<typeof cafe.connector.readParticipationContext>) =>
      cafe.connector.readParticipationContext(...args),
  };
  const ingress = new CollectiveIngressDispatcher({
    connector: connectorPort,
    threadStore: threads,
    messageStore: messages,
    invocationQueue: queue,
    queueProcessor,
    socketManager: { broadcastToRoom() {}, emitToUser() {} },
    isCatAvailable: () => true,
    // Mirrors api/src/index.ts admitStandingWork / resumeWorkRevision.
    admitStandingWork: async (source, catId) => {
      await admission.admit(source, catId);
    },
    resumeWorkRevision: async (source, event) => {
      const notice = event.workRevisionNotice;
      const recipient = event.recipient;
      if (!notice || recipient?.kind !== 'agent' || event.actor.kind !== 'human') {
        throw Object.assign(new Error('Collective Work revision notice is invalid'), {
          code: 'COLLECTIVE_REVISION_NOT_CURRENT',
        });
      }
      const feedbackHumanId = event.actor.humanId;
      const prepared = await cafe.connector.withAssignedWorkAuthority(
        recipient.connectionId,
        notice.workId,
        async (scope) => {
          if (
            scope.hostRoute?.localOwnerUserId !== source.userId ||
            scope.connection.authorizedHumanId !== feedbackHumanId
          )
            throw Object.assign(new Error('Collective Work revision belongs to another owner'), {
              code: 'CONNECTOR_OWNER_MISMATCH',
            });
          return revisionReconciler.prepare({
            ownerUserId: source.userId,
            event,
            inbox: scope.inbox,
            work: scope.work,
          });
        },
      );
      if (prepared) await revisionReconciler.dispatchPrepared(prepared);
    },
  });

  const host = {
    cafe,
    userId,
    threads,
    messages,
    tasks,
    endpoint,
    participationRevision,
    authority,
    context,
    queue,
    tracker,
    admission,
    ingress,
    dispatcher,
    resultReconciler,
    revisionReconciler,
    runs,
    hooks,
    /** The latest Task, by intendedOutcome substring; tasks are Host-private truth. */
    async taskFor(text: string) {
      const found = (await tasks.listByKind('work')).filter((task) =>
        task.entrustedWork?.intendedOutcome.includes(text),
      );
      return found.length === 1 ? found[0] : undefined;
    },
    /** Waits until no scripted Cat is executing and the Queue has nothing left on any known thread. */
    async settle() {
      let stable = 0;
      const started = Date.now();
      while (stable < 4) {
        if (Date.now() - started > 20_000) {
          const threadIds = [endpoint.id, ...(await tasks.listByKind('work')).map((task) => task.threadId)];
          const detail = async (entry: { messageId?: string | null }) => {
            const message = entry.messageId ? await messages.getById(entry.messageId) : null;
            return {
              body: message?.content?.slice(0, 60),
              event: message?.source?.meta?.eventId,
              actor: (message?.source?.meta?.actor as { kind?: string } | undefined)?.kind,
              extra: Object.keys(message?.extra ?? {}),
            };
          };
          const details = await Promise.all(threadIds.flatMap((id) => queue.list(id, userId)).map(detail));
          const snapshot = threadIds.map((id) => ({
            thread: id,
            queue: queue
              .list(id, userId)
              .map((entry) => ({ id: entry.id, status: entry.status, scope: entry.executionScope })),
            tracked: tracker.has(id),
          }));
          throw new Error(
            `Host did not settle: active=${active} ${JSON.stringify(snapshot)} runs=${JSON.stringify(runs)} details=${JSON.stringify(details)} logs=${JSON.stringify(hostLogs.slice(-8))}`,
          );
        }
        await sleep(25);
        const threadIds = [endpoint.id, ...(await tasks.listByKind('work')).map((task) => task.threadId)];
        const busy =
          active > 0 ||
          threadIds.some((id) => !heldThreads.has(id) && (queue.list(id, userId).length > 0 || tracker.has(id)));
        stable = busy ? 0 : stable + 1;
      }
    },
    /** One Host tick: pull, route every pending inbox item, let queued Cats run. */
    async tick() {
      await cafe.connector.sync(cafe.connectionId);
      const result = await ingress.dispatchConnection(cafe.connectionId);
      await host.settle();
      return result;
    },
  };
  return host;
}

export type Host = Awaited<ReturnType<typeof createHost>>;

function describe(error: unknown) {
  const candidate = error as { code?: string; message?: string };
  return `${candidate?.code ?? 'ERROR'}: ${candidate?.message ?? String(error)}`;
}

/** Ticks every Host until `done` holds (bounded). */
export async function pumpUntil(hosts: readonly Host[], world: World, done: () => boolean, label: string, max = 12) {
  for (let round = 0; round < max; round++) {
    await world.syncAll();
    for (const host of hosts) await host.tick();
    if (done()) return;
  }
  throw new Error(`Did not converge: ${label}`);
}
