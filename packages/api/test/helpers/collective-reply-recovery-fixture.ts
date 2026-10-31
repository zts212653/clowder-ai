import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import type { StoredMessage } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { registerCollectiveReplyRecovery } from '../../src/routes/collective-reply-recovery.js';

export const OWNER = 'owner';
export const THREAD = 'thread';
export const CAT = 'codex61-sol';
export const SOURCE_ID = 'source-message';
export const RESPONSE_ID = 'response-message';
export const BODY = '嗨～小太阳在呢 ☀️ 伸爪碰一下 🐾';
export const SIGNATURE = '[小太阳·砚砚/gpt-6.1-sol🐾]';
export const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

export function recoveryFixture() {
  const content = `${BODY}\n\n${SIGNATURE}`;
  const source = {
    id: SOURCE_ID,
    threadId: THREAD,
    userId: OWNER,
    catId: null,
    content: 'hi',
    from: { kind: 'plugin', instanceId: 'pi_collective' },
    mentions: [CAT],
    timestamp: 1,
    deliveryStatus: 'delivered',
    source: {
      connector: 'collective',
      label: 'Collective',
      meta: {
        participation: {
          serviceInstanceId: 'svc_12345678',
          collectiveId: 'col_12345678',
          connectionId: 'con_12345678',
          eventId: 'evt_12345678',
          location: { channelId: 'general' },
          catId: CAT,
          participationRevision: 1,
          actor: { kind: 'human', humanId: 'human_12345678', displayName: 'you' },
        },
      },
    },
    lifecycle: {
      kind: 'input',
      orderKey: `1:${SOURCE_ID}`,
      dispatchRefs: [{ targetId: CAT, phase: 'settled', statusMessageId: RESPONSE_ID, dispatchedAt: 2 }],
    },
  } as StoredMessage;
  const response = {
    id: RESPONSE_ID,
    threadId: THREAD,
    userId: OWNER,
    catId: CAT,
    content,
    from: { kind: 'agent', catId: CAT },
    mentions: [],
    replyTo: SOURCE_ID,
    origin: 'stream',
    timestamp: 2,
    lifecycle: {
      kind: 'response',
      orderKey: '2:turn-invocation',
      invocationId: 'turn-invocation',
      targetId: CAT,
      inputEntryIds: ['queue:source'],
      inputMessageIds: [SOURCE_ID],
      startedAt: 2,
      latestInputTimelineOrderAt: 2,
      status: 'completed',
      completedAt: 3,
    },
    extra: {
      outputLayout: {
        v: 1,
        owner: { threadId: THREAD, catId: CAT, turnInvocationId: 'turn-invocation' },
        contentRevision: {
          length: content.length,
          sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
        },
        status: 'available',
        runs: [
          {
            id: 'run-0',
            channel: 'final',
            start: 0,
            end: BODY.length,
            gluePrefixLength: 0,
            identity: {
              provider: 'codex',
              runtimeSessionId: 'runtime-session',
              turnId: 'turn-id',
              nativeId: 'native-id',
            },
            complete: true,
          },
        ],
        order: [{ kind: 'run', runId: 'run-0' }],
        hostTail: {
          kind: 'cat_signature',
          producer: 'codex_stream_finalizer',
          basis: 'runtime_canonical',
          start: BODY.length,
          end: content.length,
          gluePrefixLength: 2,
        },
      },
    },
  } as StoredMessage;
  return { source, response };
}

export function outputLayout(response: StoredMessage) {
  const layout = response.extra?.outputLayout;
  assert.ok(layout);
  return layout;
}

export function replaceFinalBody(response: StoredMessage, body: string, gluePrefix = '') {
  const content = `${gluePrefix}${body}\n\n${SIGNATURE}`;
  response.content = content;
  const layout = outputLayout(response);
  layout.contentRevision = {
    length: content.length,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
  layout.runs[0] = {
    ...layout.runs[0],
    start: 0,
    end: gluePrefix.length + body.length,
    gluePrefixLength: gluePrefix.length,
  };
  layout.hostTail = {
    ...layout.hostTail,
    start: gluePrefix.length + body.length,
    end: content.length,
    gluePrefixLength: 2,
  };
}

export async function openRecoveryHarness({
  mutate,
  catAvailable = true,
}: {
  mutate?: (value: ReturnType<typeof recoveryFixture>) => void;
  catAvailable?: boolean;
} = {}) {
  const value = recoveryFixture();
  mutate?.(value);
  const records = new Map<string, StoredMessage>([
    [value.source.id, value.source],
    [value.response.id, value.response],
  ]);
  const queue = new InvocationQueue();
  const requestDrain = mock.fn(async () => {});
  const app = Fastify();
  registerCollectiveReplyRecovery(
    app,
    {
      invocationQueue: queue,
      queueProcessor: { requestDrain } as never,
      messageStore: { getById: async (id: string) => records.get(id) ?? null } as never,
      isCatAvailable: () => catAvailable,
      socketManager: { emitToUser: mock.fn() } as never,
    } as never,
    async (request, reply, threadId) => {
      if (threadId !== THREAD || request.headers['x-cat-cafe-user'] !== OWNER) {
        reply.code(404).send({ code: 'NOT_FOUND' });
        return null;
      }
      return { userId: OWNER };
    },
  );
  await app.ready();
  return {
    app,
    queue,
    requestDrain,
    value,
    post: (input: { owner?: string; catId?: string; requestId?: string } = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/threads/${THREAD}/messages/${SOURCE_ID}/collective-reply-recovery/${input.catId ?? CAT}`,
        headers: { 'x-cat-cafe-user': input.owner ?? OWNER },
        payload: { requestId: input.requestId ?? REQUEST_ID },
      }),
  };
}
