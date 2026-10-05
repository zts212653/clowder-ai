'use client';

import type { DeploymentWaitItemProjection } from '@cat-cafe/shared';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { ThreadChatLink } from './ThreadChatLink';

function shortRevision(revision: string): string {
  return revision.slice(0, 8);
}

function relativeDuration(item: DeploymentWaitItemProjection, now: number): string {
  const createdAt = item.createdAt;
  if (createdAt === null) return '等待时长未知';
  const elapsed = Math.max(0, (item.matchedAt ?? now) - createdAt);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return '刚刚登记';
  if (minutes < 60) return `已等待 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `已等待 ${hours} 小时`;
  return `已等待 ${Math.floor(hours / 24)} 天`;
}

function conditionLabel(item: DeploymentWaitItemProjection): string {
  const services = item.condition.services.map((service) => service.toUpperCase()).join(' + ');
  return item.condition.kind === 'revision_included'
    ? `包含 ${shortRevision(item.condition.revision)}，${services} 就绪`
    : `出现新启动，${services} 就绪`;
}

export function WorkspaceDeploymentWaitItem({ item, now }: { item: DeploymentWaitItemProjection; now: number }) {
  const { getCatById } = useCatData();
  const owner = item.ownerCatId ? resolveCatDisplayName(item.ownerCatId, getCatById) : '待确认负责猫';
  return (
    <article className="py-3.5" data-testid="workspace-deployment-wait-item">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-52 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h4 className="text-xs font-semibold text-cafe-black">{item.taskTitle}</h4>
            <span className="text-micro text-cafe-muted">{relativeDuration(item, now)}</span>
          </div>
          <p className="mt-1 text-micro text-cafe-secondary">
            {owner} · {item.threadTitle ?? '原对话'} · {item.deploymentId}
          </p>
          <p className="mt-1 text-micro text-cafe-muted">{conditionLabel(item)}</p>
          {item.stateReason === 'deployment_evidence_unavailable' && (
            <p className="mt-1 text-micro text-conn-amber-text">运行证据暂不可用，仍保留这项等待。</p>
          )}
          {item.stateReason === 'deployment_evidence_incomplete' && (
            <p className="mt-1 text-micro text-conn-amber-text">运行证据还不完整，暂不能判断已经满足。</p>
          )}
          {item.stateReason === 'deployment_match_pending_recheck' && (
            <p className="mt-1 text-micro text-conn-amber-text">检测到可能就绪，正在复核并安排原猫接回。</p>
          )}
          <p className="mt-1.5 text-xs text-cafe-secondary">
            <span className="font-medium text-cafe-black">接回后：</span>
            {item.nextStep || '回原任务确认下一步'}
          </p>
        </div>
        <ThreadChatLink threadId={item.threadId} />
      </div>
    </article>
  );
}
