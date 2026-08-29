import { type CloudBridgeOutboundReceiptV1, createCatId, isCloudBridgeOutboundReceiptV1 } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import { resolveVisibleReplyParent } from '../../stores/visibility.js';
import type { PersistenceContext } from './route-helpers.js';

const log = createModuleLogger('route-system-info-persistence');

const SESSION_ROLLOVER_STATUSES = new Set(['pending', 'succeeded', 'failed']);
const SESSION_ROLLOVER_REASONS = new Set(['oversized_retire', 'resume_rejected']);
const SESSION_ROLLOVER_FAILURE_STAGES = new Set([
  'seal_request',
  'seal_finalize',
  'replacement_create',
  'replacement_bind',
]);

interface SessionRolloverNoticeMetadata {
  readonly rolloverId: string;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly reason: 'oversized_retire' | 'resume_rejected';
  readonly failureStage?: 'seal_request' | 'seal_finalize' | 'replacement_create' | 'replacement_bind';
}

function parseSessionRolloverNotice(parsed: {
  type?: unknown;
  v?: unknown;
  rolloverId?: unknown;
  status?: unknown;
  reason?: unknown;
  failureStage?: unknown;
}):
  | {
      content: string;
      connector: string;
      label: string;
      icon: string;
      tone: 'info' | 'warning';
      idempotencyKey: string;
      sessionRollover: SessionRolloverNoticeMetadata;
    }
  | undefined {
  if (parsed.type !== 'session_rollover_lifecycle' || parsed.v !== 1) return undefined;
  if (
    typeof parsed.rolloverId !== 'string' ||
    parsed.rolloverId.length === 0 ||
    parsed.rolloverId.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(parsed.rolloverId)
  ) {
    return undefined;
  }
  if (typeof parsed.status !== 'string' || !SESSION_ROLLOVER_STATUSES.has(parsed.status)) return undefined;
  if (typeof parsed.reason !== 'string' || !SESSION_ROLLOVER_REASONS.has(parsed.reason)) return undefined;
  if (parsed.status === 'failed') {
    if (typeof parsed.failureStage !== 'string' || !SESSION_ROLLOVER_FAILURE_STAGES.has(parsed.failureStage)) {
      return undefined;
    }
  } else if (parsed.failureStage !== undefined) {
    return undefined;
  }

  const status = parsed.status as SessionRolloverNoticeMetadata['status'];
  const reason = parsed.reason as SessionRolloverNoticeMetadata['reason'];
  const failureStage = parsed.failureStage as SessionRolloverNoticeMetadata['failureStage'];
  const content =
    status === 'pending'
      ? reason === 'oversized_retire'
        ? '正在封存上下文载荷过大的原生会话，并准备冷启动替代会话…'
        : '正在封存无法恢复的原生会话，并准备冷启动替代会话…'
      : status === 'succeeded'
        ? reason === 'oversized_retire'
          ? '原生会话因上下文载荷过大已自动封存；已切换到新的冷启动会话。'
          : '无法恢复的原生会话已自动封存；已切换到新的冷启动会话。'
        : '原生会话自动封存与冷切换失败；本轮已在发送新 prompt 前停止。';

  return {
    content,
    connector: 'session-rollover-lifecycle',
    label: '会话冷切换',
    icon: status === 'failed' ? '⚠️' : '♻️',
    tone: status === 'failed' ? 'warning' : 'info',
    idempotencyKey: `session-rollover:${parsed.rolloverId}:${status}`,
    sessionRollover: {
      rolloverId: parsed.rolloverId,
      status,
      reason,
      ...(failureStage ? { failureStage } : {}),
    },
  };
}

function projectOutboundReceipt(value: unknown): CloudBridgeOutboundReceiptV1 | undefined {
  if (!isCloudBridgeOutboundReceiptV1(value)) return undefined;
  return {
    v: 1,
    sourceMessageId: value.sourceMessageId,
    sourceSender: {
      kind: value.sourceSender.kind,
      id: value.sourceSender.id,
      ...(value.sourceSender.invocationId ? { invocationId: value.sourceSender.invocationId } : {}),
    },
    dispatchInvocationId: value.dispatchInvocationId,
    targetCatId: value.targetCatId,
    status: value.status,
    transport: value.transport,
    ...(value.hostMessageId ? { hostMessageId: value.hostMessageId } : {}),
    ...(value.failure ? { failure: value.failure } : {}),
    idempotency: {
      keyKind: 'source_message_id',
      disposition: value.idempotency.disposition,
    },
  };
}

function parseVisibleNotice(
  content: string,
  catId: string,
):
  | {
      content: string;
      connector: string;
      label: string;
      icon: string;
      tone: 'info' | 'warning';
      replyTo?: string;
      outboundReceipt?: CloudBridgeOutboundReceiptV1;
      idempotencyKey?: string;
      sessionRollover?: SessionRolloverNoticeMetadata;
    }
  | undefined {
  try {
    const parsed = JSON.parse(content) as {
      type?: unknown;
      v?: unknown;
      status?: unknown;
      reason?: unknown;
      rolloverId?: unknown;
      failureStage?: unknown;
      message?: unknown;
      outboundReceipt?: unknown;
    };
    if (parsed.type === 'session_rollover_lifecycle') {
      return parseSessionRolloverNotice(parsed);
    }
    if (typeof parsed.message !== 'string') return undefined;
    if (parsed.type === 'warning') {
      return {
        content: parsed.message ? `⚠️ ${parsed.message}` : '⚠️ Warning',
        connector: 'system-warning',
        label: '系统警告',
        icon: '⚠️',
        tone: 'warning',
      };
    }
    if (parsed.type === 'a2a_multi_target_serialized') {
      return {
        content: parsed.message,
        connector: 'a2a-routing-mode',
        label: '调度模式',
        icon: '🔀',
        tone: 'info',
      };
    }
    if (parsed.type === 'cloud_bridge_status') {
      const outboundReceipt = projectOutboundReceipt(parsed.outboundReceipt);
      const unavailable = outboundReceipt ? outboundReceipt.status !== 'sent' : parsed.status === 'unavailable';
      return {
        content: parsed.message,
        connector: 'cloud-bridge-status',
        label: '云端猫投递',
        icon: unavailable ? '⚠️' : '☁️',
        tone: unavailable ? 'warning' : 'info',
        ...(outboundReceipt
          ? {
              replyTo: outboundReceipt.sourceMessageId,
              outboundReceipt,
            }
          : {}),
      };
    }
    return undefined;
  } catch (parseErr) {
    log.warn({ catId, err: parseErr }, 'Ignoring non-JSON user-facing system_info content');
    return undefined;
  }
}

type VisibleNotice = NonNullable<ReturnType<typeof parseVisibleNotice>>;

async function appendVisibleNotice(
  messageStore: IMessageStore,
  threadId: string,
  notice: VisibleNotice,
  catId: string,
  expectedSourceMessageId: string | undefined,
  expectedDispatchInvocationId: string | undefined,
): Promise<void> {
  const outboundReceipt = notice.outboundReceipt
    ? await validateOutboundReceipt({
        messageStore,
        threadId,
        catId,
        expectedSourceMessageId,
        expectedDispatchInvocationId,
        receipt: notice.outboundReceipt,
      })
    : undefined;
  await messageStore.append({
    userId: 'system',
    catId: null,
    threadId,
    content: notice.content,
    mentions: [],
    timestamp: Date.now(),
    ...(notice.idempotencyKey ? { idempotencyKey: notice.idempotencyKey } : {}),
    ...(outboundReceipt ? { replyTo: outboundReceipt.sourceMessageId } : {}),
    source: {
      connector: notice.connector,
      label: notice.label,
      icon: notice.icon,
      meta: {
        presentation: 'system_notice',
        noticeTone: notice.tone,
        ...(notice.sessionRollover ? { sessionRollover: notice.sessionRollover } : {}),
        ...(outboundReceipt ? { cloudBridgeOutboundReceipt: outboundReceipt } : {}),
      },
    },
  });
}

async function validateOutboundReceipt(args: {
  messageStore: IMessageStore;
  threadId: string;
  catId: string;
  expectedSourceMessageId: string | undefined;
  expectedDispatchInvocationId: string | undefined;
  receipt: CloudBridgeOutboundReceiptV1;
}): Promise<CloudBridgeOutboundReceiptV1 | undefined> {
  const { receipt } = args;
  if (
    !args.expectedSourceMessageId ||
    receipt.sourceMessageId !== args.expectedSourceMessageId ||
    !args.expectedDispatchInvocationId ||
    receipt.dispatchInvocationId !== args.expectedDispatchInvocationId ||
    receipt.targetCatId !== args.catId
  ) {
    log.warn(
      {
        threadId: args.threadId,
        catId: args.catId,
        sourceMessageId: receipt.sourceMessageId,
        dispatchInvocationId: receipt.dispatchInvocationId,
      },
      'Dropping cloud outbound receipt with mismatched server dispatch context',
    );
    return undefined;
  }
  const source = await resolveVisibleReplyParent(args.messageStore, receipt.sourceMessageId, {
    threadId: args.threadId,
    viewer: { type: 'cat', catId: createCatId(args.catId) },
    publicReply: true,
  });
  if (!source) return undefined;

  const senderMatches =
    receipt.sourceSender.kind === 'user'
      ? source.catId === null && source.userId === receipt.sourceSender.id
      : source.catId === createCatId(receipt.sourceSender.id);
  if (!senderMatches) return undefined;
  if (receipt.sourceSender.invocationId) {
    const storedInvocationIds = new Set(
      [source.extra?.stream?.turnInvocationId, source.extra?.stream?.invocationId].filter((value): value is string =>
        Boolean(value),
      ),
    );
    if (!storedInvocationIds.has(receipt.sourceSender.invocationId)) return undefined;
  }
  return receipt;
}

function recordPersistenceFailure(
  catId: string,
  persistErr: unknown,
  persistenceContext: PersistenceContext | undefined,
): void {
  log.error({ catId, err: persistErr }, 'Failed to persist user-facing system_info notice');
  if (!persistenceContext) return;
  persistenceContext.failed = true;
  persistenceContext.errors.push({
    catId,
    error: persistErr instanceof Error ? persistErr.message : String(persistErr),
  });
}

export async function persistUserFacingSystemInfoNotices(options: {
  messageStore: IMessageStore;
  threadId: string;
  catId: string;
  contents: readonly string[];
  expectedSourceMessageId?: string;
  expectedDispatchInvocationId?: string;
  persistenceContext?: PersistenceContext;
}): Promise<void> {
  const {
    messageStore,
    threadId,
    catId,
    contents,
    expectedSourceMessageId,
    expectedDispatchInvocationId,
    persistenceContext,
  } = options;

  for (const content of contents) {
    const notice = parseVisibleNotice(content, catId);
    if (notice == null) continue;

    try {
      await appendVisibleNotice(
        messageStore,
        threadId,
        notice,
        catId,
        expectedSourceMessageId,
        expectedDispatchInvocationId,
      );
    } catch (persistErr) {
      recordPersistenceFailure(catId, persistErr, persistenceContext);
    }
  }
}
