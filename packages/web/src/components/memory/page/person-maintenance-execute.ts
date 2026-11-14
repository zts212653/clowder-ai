import { notifyMemoryChanged } from '@/hooks/memory-changed';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import {
  beginPersonMaintenance,
  finishPersonMaintenance,
  type PendingPersonMaintenance,
  readPendingPersonMaintenance,
  settlePersonMaintenance,
} from './person-maintenance-recovery';

const errors: Record<string, string> = {
  stale_revision: '版本已变化，请重读后再决定。',
  conflict: '记录已变化，请重读后再决定。',
  idempotency_conflict: '这次操作与已记录的请求不同，请重读后再决定。',
  proposal_bound: '这条线索已生成正式提议，请重读列表并前往原提议处理。',
  receipt_not_withdrawable: '这条线索已不能撤回，请重读后查看当前状态。',
  not_available: '这条记录已不可用，请重读列表。',
  invalid_action: '无法确认主人操作权限，请重新打开页面。',
};
export const personMaintenanceUnknown = '结果尚未确认；重试会继续同一次操作。';
export async function executePersonMaintenance(owner: string, command: PendingPersonMaintenance) {
  const sameOwner = () => apiSessionIdentity.getSnapshot().ownerUserId === owner;
  if (
    !sameOwner() ||
    readPendingPersonMaintenance(owner)?.requestId !== command.requestId ||
    !beginPersonMaintenance(owner)
  )
    return { outcome: 'unavailable' as const, message: '' };
  try {
    const path =
      command.action === 'redact_item'
        ? `/api/memory/people/${encodeURIComponent(command.personId)}/actions`
        : `/api/memory/people/deferred/${encodeURIComponent(command.receiptId)}/actions`;
    const payload =
      command.action === 'redact_item'
        ? {
            action: command.action,
            item: command.item,
            expectedRevision: command.expectedRevision,
            requestId: command.requestId,
            confirmed: true,
          }
        : {
            action: command.action,
            expectedRevision: command.expectedRevision,
            requestId: command.requestId,
            confirmed: true,
          };
    const response = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const raw: unknown = await response.json();
    if (!sameOwner()) return { outcome: 'owner_changed' as const, message: '' };
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    if (response.ok && body.action === command.action && ['applied', 'replayed'].includes(String(body.outcome))) {
      settlePersonMaintenance(owner, command);
      notifyMemoryChanged();
      const message = command.action === 'withdraw' ? '已撤回暂存条目。' : '已忘掉这条内容。';
      useToastStore.getState().addToast({
        type: 'success',
        title: command.action === 'withdraw' ? '已撤回暂存' : '已忘掉',
        message: `${message}原始对话保留。`,
        duration: 6000,
      });
      return {
        outcome: 'applied' as const,
        message,
      };
    }
    if ([400, 401, 403, 404, 409].includes(response.status)) {
      settlePersonMaintenance(owner, command);
      return { outcome: 'refused' as const, message: errors[String(body.error)] ?? '未执行这次操作，请重读后再决定。' };
    }
    return { outcome: 'unknown' as const, message: personMaintenanceUnknown };
  } catch {
    return { outcome: 'unknown' as const, message: sameOwner() ? personMaintenanceUnknown : '' };
  } finally {
    finishPersonMaintenance(owner);
  }
}
