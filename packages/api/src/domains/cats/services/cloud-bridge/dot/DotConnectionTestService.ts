import { randomBytes, randomUUID } from 'node:crypto';
import { createCatId } from '@cat-cafe/shared';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { IThreadStore } from '../../stores/ports/ThreadStore.js';
import type { CloudReturnGrantStore } from '../cloud-return-grant.js';
import type { BridgeDispatchOutcome, CloudInvokeDispatchParams } from '../types.js';
import type { DotConnectionService } from './DotConnectionService.js';
import { type DotDispatchRecord, type DotDispatchStore, dotEventId } from './DotDispatchStore.js';
import type { DotEventsBridge } from './DotEventsBridge.js';
import type { DotConnectionState } from './dot-connection-state.js';

interface PreparedTestSource {
  params: CloudInvokeDispatchParams;
  completedOrInFlight?: BridgeDispatchOutcome;
}

/** The owner's setup action admits exactly two test sources; retries reuse them. */
export class DotConnectionTestService {
  private readonly pending = new Map<
    string,
    Promise<{ tests: Array<{ threadId: string; outcome: BridgeDispatchOutcome }> }>
  >();
  constructor(
    private readonly options: {
      connection: DotConnectionService;
      dispatches: DotDispatchStore;
      bridge: DotEventsBridge;
      messages: Pick<IMessageStore, 'append' | 'getById'>;
      threads: Pick<IThreadStore, 'create' | 'get'>;
      grants: Pick<CloudReturnGrantStore, 'issue'>;
      projectPath: string;
    },
  ) {}

  run(ownerUserId: string) {
    const existing = this.pending.get(ownerUserId);
    if (existing) return existing;
    const work = this.start(ownerUserId).finally(() => {
      if (this.pending.get(ownerUserId) === work) this.pending.delete(ownerUserId);
    });
    this.pending.set(ownerUserId, work);
    return work;
  }

  private async start(ownerUserId: string) {
    const current = await this.options.connection.current();
    if (!current || current.ownerUserId !== ownerUserId) throw new Error('dot_owner_mismatch');
    const state = await this.options.connection.authenticate(current.credentialSecret);
    const status = await this.options.connection.status(ownerUserId);
    if (!status.paired || status.subscription !== 'active') throw new Error('dot_subscription_unavailable');
    const sources = state.testEventIds.length
      ? await Promise.all(state.testEventIds.map((id) => this.resumeSource(id, state)))
      : await Promise.all(['A', 'B'].map(async (label) => ({ params: await this.createSource(label, state) })));
    await this.options.connection.setOwnerPreferences(
      ownerUserId,
      {
        testEventIds: sources.map(({ params }) =>
          dotEventId(state.attemptId, params.threadId, params.sourceMessageId, params.dispatchInvocationId!),
        ),
      },
      state.attemptId,
    );
    const outcomes = await Promise.all(
      sources.map(
        (source: PreparedTestSource) =>
          source.completedOrInFlight ?? this.options.bridge.dispatchConnectionTest(source.params),
      ),
    );
    return { tests: sources.map(({ params }, index) => ({ threadId: params.threadId, outcome: outcomes[index]! })) };
  }

  private async createSource(label: string, state: DotConnectionState): Promise<CloudInvokeDispatchParams> {
    const thread = await this.options.threads.create(
      state.ownerUserId,
      `dot 接入验证 ${label}`,
      this.options.projectPath,
    );
    const nonce = randomBytes(8).toString('hex');
    const message = await this.options.messages.append({
      threadId: thread.id,
      userId: state.ownerUserId,
      from: { kind: 'user', userId: state.ownerUserId },
      content: `dot 接入验证 ${label}：请读取这条原消息，在原对话回复随机标识 ${nonce}。这是连接测试，不授权其他工作。`,
      mentions: [],
      timestamp: Date.now(),
    });
    const invocationId = `dot-test:${randomUUID()}`;
    const params = this.params(state, thread.id, thread.title, message.id, message.content, invocationId);
    const grant = await this.options.grants.issue({
      threadId: thread.id,
      userId: state.ownerUserId,
      sourceMessageId: message.id,
      dispatchInvocationId: invocationId,
      targetCatId: 'gpt-dot',
    });
    if (!grant.ok) throw new Error('dot_test_grant_unavailable');
    const id = dotEventId(state.attemptId, thread.id, message.id, invocationId);
    await this.options.dispatches.update(id, async (record) => ({
      record: record ?? {
        eventId: id,
        ownerUserId: state.ownerUserId,
        threadId: thread.id,
        sourceMessageId: message.id,
        dispatchInvocationId: invocationId,
        attemptId: state.attemptId,
        agentKeyId: state.agentKeyId,
        occurredAt: Date.now(),
        webhookAcknowledgedAt: null,
        sourceReadAt: null,
        replyMessageId: null,
        imagePublicationIds: [],
        connectionTest: true,
        expectedNonce: nonce,
      },
      result: undefined,
    }));
    return params;
  }

  private async resumeSource(id: string, state: DotConnectionState): Promise<PreparedTestSource> {
    const record = await this.options.dispatches.read(id);
    if (
      !record?.connectionTest ||
      record.ownerUserId !== state.ownerUserId ||
      record.attemptId !== state.attemptId ||
      record.agentKeyId !== state.agentKeyId
    )
      throw new Error('dot_test_source_unavailable');
    const thread = await this.options.threads.get(record.threadId);
    const message = await this.options.messages.getById(record.sourceMessageId);
    if (!thread || !message || thread.deletedAt || message.deletedAt) throw new Error('dot_test_source_unavailable');
    const previous = this.params(
      state,
      thread.id,
      thread.title,
      message.id,
      message.content,
      record.dispatchInvocationId,
    );
    if (record.replyMessageId) return this.keepReceipt(previous, record);
    const invocationId = `dot-test:${randomUUID()}`;
    const grant = await this.options.grants.issue({
      threadId: thread.id,
      userId: state.ownerUserId,
      sourceMessageId: message.id,
      dispatchInvocationId: invocationId,
      targetCatId: 'gpt-dot',
    });
    // A pending append lease or already-consumed grant belongs to the original
    // callback. Never replace its generation or send another event over it.
    if (!grant.ok) {
      if (grant.reason === 'in_flight') return this.keepReceipt(previous, record);
      throw new Error('dot_test_grant_unavailable');
    }
    if (grant.status === 'existing') return this.keepReceipt(previous, record);
    const eventId = dotEventId(state.attemptId, thread.id, message.id, invocationId);
    await this.options.dispatches.update(eventId, async () => ({
      record: {
        ...record,
        eventId,
        dispatchInvocationId: invocationId,
        occurredAt: Date.now(),
        webhookAcknowledgedAt: null,
        sourceReadAt: null,
        replyMessageId: null,
        imagePublicationIds: [],
        imageReservationIds: [],
      },
      result: undefined,
    }));
    return { params: this.params(state, thread.id, thread.title, message.id, message.content, invocationId) };
  }

  private keepReceipt(params: CloudInvokeDispatchParams, record: DotDispatchRecord): PreparedTestSource {
    return {
      params,
      completedOrInFlight: {
        kind: 'sent',
        transport: 'events',
        capturedUrl: `mcp-event:${record.eventId}`,
        hostMessageId: record.eventId,
        idempotentReplay: true,
      },
    };
  }

  private params(
    state: DotConnectionState,
    threadId: string,
    threadTitle: string | null,
    sourceMessageId: string,
    intent: string,
    dispatchInvocationId: string,
  ): CloudInvokeDispatchParams {
    return {
      catId: createCatId('gpt-dot'),
      userId: state.ownerUserId,
      threadId,
      threadTitle,
      sourceMessageId,
      dispatchInvocationId,
      intent,
      participants: [],
      calledBy: 'user',
    };
  }
}
