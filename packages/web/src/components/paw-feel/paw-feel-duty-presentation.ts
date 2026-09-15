import type { PawFeelInboxItem } from '@cat-cafe/shared';

function responsibilityDetail(item: PawFeelInboxItem): string | undefined {
  switch (item.responsibility.exitKind) {
    case 'signature_request':
      return `等待独立签署；排除报告猫 @${item.responsibility.signerExclusionCatId ?? 'unknown'} 自签${
        item.responsibility.preferredSignerCatId ? ` · 首选 @${item.responsibility.preferredSignerCatId}` : ''
      }`;
    case 'explicit_blocker':
      return `阻塞 ${item.responsibility.blocker?.code ?? 'unknown'} · ${item.responsibility.blocker?.ref ?? ''}`;
    case 'pending_proposal':
      return `等待 durable proposal ${item.responsibility.proposalId ?? 'unavailable'} 获批`;
    default:
      return undefined;
  }
}

function dispositionDetail(item: PawFeelInboxItem): string | undefined {
  const { disposition } = item;
  switch (disposition.state) {
    case 'routed':
      return `已移交至 ${disposition.targetThreadId ?? disposition.proposalId ?? '责任面'}，不代表已经修复`;
    case 'route_pending':
      return disposition.targetThreadId
        ? `等待 ${disposition.targetThreadId} 接单`
        : `F128 proposal ${disposition.proposalId ?? 'unavailable'} 当前不是 pending，需重新路由或显式阻塞`;
    case 'duplicate':
      return disposition.duplicateOf ? `重复于 ${disposition.duplicateOf}` : undefined;
    case 'fix': {
      const binding = `由 @${disposition.ownerCatId ?? 'unknown'} 负责 · 任务 ${
        disposition.taskId ?? 'unavailable'
      } · F167 lease ${disposition.actionLeaseRef?.leaseId ?? 'unavailable'}`;
      return item.responsibility.validExit ? binding : `${binding} · 当前 active lease 复验失败`;
    }
    default:
      return disposition.reasonCode ? `理由：${disposition.reasonCode}` : undefined;
  }
}

export function pawFeelDutyDetail(item: PawFeelInboxItem): string | undefined {
  return responsibilityDetail(item) ?? dispositionDetail(item);
}
