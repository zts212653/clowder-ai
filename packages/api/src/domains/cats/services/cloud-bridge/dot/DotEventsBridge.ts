import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { IThreadStore } from '../../stores/ports/ThreadStore.js';
import type { BridgeDispatchOutcome, CloudInvokeDispatchParams } from '../types.js';
import type { DotConnectionService } from './DotConnectionService.js';
import { DotDispatchStore, dotEventId } from './DotDispatchStore.js';
import { DOT_CAT_ID } from './dot-connection-state.js';
import { canDeliverDotSource } from './dot-reply-authority.js';
import { type DotWebhookSend, dotWebhookHeaders, sendDotWebhookPinned } from './dot-webhook.js';

export class DotEventsBridge {
  private readonly sending = new Map<string, Promise<BridgeDispatchOutcome>>();
  constructor(
    private readonly options: {
      connection: DotConnectionService;
      dispatches: DotDispatchStore;
      messageStore: Pick<IMessageStore, 'getById'>;
      threadStore: Pick<IThreadStore, 'get'>;
      enabled: () => Promise<boolean>;
      sendWebhook?: DotWebhookSend;
      now?: () => number;
    },
  ) {}

  async dispatch(params: CloudInvokeDispatchParams): Promise<BridgeDispatchOutcome> {
    return this.admit(params, false);
  }

  /** Only the authenticated owner setup route calls this, with newly persisted test sources and grants. */
  async dispatchConnectionTest(params: CloudInvokeDispatchParams): Promise<BridgeDispatchOutcome> {
    return this.admit(params, true);
  }

  private async admit(params: CloudInvokeDispatchParams, connectionTest: boolean): Promise<BridgeDispatchOutcome> {
    if (params.catId !== DOT_CAT_ID || !params.dispatchInvocationId)
      return this.unavailable('dot 召唤缺少有效执行来源。');
    const thread = await this.options.threadStore.get(params.threadId);
    const source = await this.options.messageStore.getById(params.sourceMessageId);
    if (
      !thread ||
      thread.deletedAt ||
      thread.createdBy !== params.userId ||
      !source ||
      source.deletedAt ||
      source.recall ||
      source._tombstone ||
      source.threadId !== params.threadId ||
      source.userId !== params.userId ||
      source.catId === DOT_CAT_ID
    ) {
      return this.unavailable('原对话或召唤来源无法核实。');
    }
    const admissionState = await this.options.connection.current();
    if (
      source.catId &&
      (connectionTest ||
        !admissionState ||
        !(await canDeliverDotSource(admissionState, source, this.options.messageStore)))
    )
      return this.unavailable('召唤来源无法核实，或原询问已失效。');
    if (!connectionTest && !(await this.options.enabled()))
      return this.unavailable('dot 尚未启用，请到插件详情完成往返验证。');
    const status = await this.options.connection.status(params.userId);
    if (!status.attemptId || !status.paired || status.subscription !== 'active')
      return this.unavailable('dot 订阅未就绪或已到期。');
    const id = dotEventId(status.attemptId, params.threadId, params.sourceMessageId, params.dispatchInvocationId);
    if (connectionTest) {
      const test = await this.options.dispatches.read(id);
      if (
        !test?.connectionTest ||
        !test.expectedNonce ||
        test.ownerUserId !== params.userId ||
        test.attemptId !== status.attemptId
      )
        return this.unavailable('接入测试尚未由主人登记。');
    }
    const existing = this.sending.get(id);
    if (existing) return existing;
    const pending = this.send(id, params, connectionTest).finally(() => {
      if (this.sending.get(id) === pending) this.sending.delete(id);
    });
    this.sending.set(id, pending);
    return pending;
  }

  private async send(
    id: string,
    params: CloudInvokeDispatchParams,
    connectionTest: boolean,
  ): Promise<BridgeDispatchOutcome> {
    const state = await this.options.connection.current();
    if (!state?.subscription) return this.unavailable('dot 订阅未就绪。');
    if (id !== dotEventId(state.attemptId, params.threadId, params.sourceMessageId, params.dispatchInvocationId!)) {
      return this.unavailable('dot 接入已变化，请从原处重新发起。');
    }
    const persisted = await this.options.dispatches.update(id, async (record) => ({
      record: record ?? {
        eventId: id,
        ownerUserId: params.userId,
        threadId: params.threadId,
        sourceMessageId: params.sourceMessageId,
        dispatchInvocationId: params.dispatchInvocationId!,
        attemptId: state.attemptId,
        agentKeyId: state.agentKeyId,
        occurredAt: this.now(),
        webhookAcknowledgedAt: null,
        sourceReadAt: null,
        replyMessageId: null,
        imagePublicationIds: [],
        connectionTest,
      },
      result: record,
    }));
    if (persisted?.webhookAcknowledgedAt) return this.receipt(id, true);
    for (let attempt = 0; attempt < 3; attempt++) {
      const fresh = await this.options.connection.authenticate(state.credentialSecret);
      if (
        (!connectionTest && !(await this.options.enabled())) ||
        fresh.attemptId !== state.attemptId ||
        !fresh.subscription ||
        (fresh.subscription.expiresAt !== null && fresh.subscription.expiresAt <= this.now())
      )
        return this.unavailable('dot 授权或订阅已变化。');
      const source = await this.options.messageStore.getById(params.sourceMessageId);
      const thread = await this.options.threadStore.get(params.threadId);
      if (
        !source ||
        source.deletedAt ||
        source.recall ||
        source._tombstone ||
        source.threadId !== params.threadId ||
        source.userId !== params.userId ||
        !thread ||
        thread.deletedAt ||
        thread.createdBy !== params.userId ||
        source.catId === DOT_CAT_ID ||
        (source.catId && (connectionTest || !(await canDeliverDotSource(fresh, source, this.options.messageStore))))
      )
        return this.unavailable('召唤来源或权限已变化。');
      const record = await this.options.dispatches.read(id);
      if (!record) throw new Error('dot_dispatch_record_unavailable');
      const body = JSON.stringify({
        eventId: id,
        name: 'dot.summoned',
        timestamp: new Date(record.occurredAt).toISOString(),
        data: {
          event_id: id,
          thread_id: params.threadId,
          source_message_id: params.sourceMessageId,
          dispatch_invocation_id: params.dispatchInvocationId,
        },
        cursor: null,
      });
      try {
        const response = await (this.options.sendWebhook ?? sendDotWebhookPinned)(
          fresh.subscription.url,
          dotWebhookHeaders(
            id,
            fresh.subscription.id,
            fresh.subscription.secret,
            body,
            this.now(),
            fresh.subscription.rotationUntil && fresh.subscription.rotationUntil > this.now()
              ? (fresh.subscription.previousSecret ?? undefined)
              : undefined,
          ),
          body,
        );
        if (response.status >= 200 && response.status < 300) {
          await this.options.dispatches.update(id, async (latest) => {
            if (!latest) throw new Error('dot_dispatch_record_unavailable');
            return { record: { ...latest, webhookAcknowledgedAt: this.now() }, result: undefined };
          });
          return this.receipt(id, false);
        }
        if (![408, 429].includes(response.status) && response.status < 500) break;
      } catch {
        /* A network failure is an unknown receipt; retries preserve the same event. */
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
    return { kind: 'error', reason: 'dispatch-failed', message: 'dot 事件收件尚未确认，可在原请求查看状态。' };
  }

  private receipt(id: string, replay: boolean): BridgeDispatchOutcome {
    return {
      kind: 'sent',
      transport: 'events',
      capturedUrl: `mcp-event:${id}`,
      hostMessageId: id,
      idempotentReplay: replay,
    };
  }
  private unavailable(detail: string): BridgeDispatchOutcome {
    return { kind: 'fallback', reason: 'no-adapter', detail };
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
}
