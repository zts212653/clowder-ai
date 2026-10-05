import type { DevelopmentReturnRegistrationV1 } from '@cat-cafe/shared';
import type { DevelopmentReturnDeps } from './DevelopmentReturnService.js';

/** Delivery diagnostics belong to the original readable thread, without agent execution or Task mutation. */
export async function publishDevelopmentReturnRetirement(
  deps: Pick<DevelopmentReturnDeps, 'threads' | 'messages' | 'emit'>,
  state: DevelopmentReturnRegistrationV1,
  now: number,
  signal: AbortSignal,
): Promise<void> {
  const owner = await deps.threads.get(state.ownerThreadId);
  if (!owner || owner.deletedAt || owner.createdBy !== state.ownerUserId) return;
  signal.throwIfAborted();
  const message = await deps.messages.append({
    userId: state.ownerUserId,
    threadId: state.ownerThreadId,
    catId: null,
    mentions: [],
    timestamp: now,
    idempotencyKey: `${state.registrationId}:retirement-notice`,
    content: `开发回流登记已失效：${state.registrationId}。原责任或来源资格已变化，本登记停止续办；此通知不恢复授权，也不代表工作完成。原 owner 可读取登记和当前可读事实。`,
    source: {
      connector: 'development-return',
      label: '开发回流登记失效',
      icon: 'cat-cafe',
      meta: { registrationId: state.registrationId, reason: 'owner_changed' },
    },
  });
  deps.emit(state.ownerUserId, 'connector_message', {
    threadId: state.ownerThreadId,
    message: {
      id: message.id,
      type: 'connector',
      content: message.content,
      source: message.source,
      timestamp: message.timestamp,
    },
  });
}
