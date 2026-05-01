import type { AgentHookHealthStatus, AgentHookStatusResponse, AgentHookTargetHealth } from '@/hooks/useAgentHookHealth';
import { HubIcon } from './hub-icons';

export type { AgentHookStatusResponse } from '@/hooks/useAgentHookHealth';

interface AgentHookHealthNoticeProps {
  health: AgentHookStatusResponse | null;
  error?: string | null;
  syncing?: boolean;
  synced?: boolean;
  onSync: () => void | Promise<void>;
  className?: string;
}

interface RenderProbe {
  health: AgentHookStatusResponse | null;
  error?: string | null;
  syncing?: boolean;
  synced?: boolean;
}

type AgentHookHealthDisplayStatus = AgentHookHealthStatus | 'unknown';

const STATUS_LABELS: Record<AgentHookHealthDisplayStatus, string> = {
  configured: '正常',
  missing: '缺失',
  stale: '过期',
  unsupported: '未启用',
  error: '异常',
  unknown: '未知',
};

const STATUS_WEIGHT: Record<AgentHookHealthStatus, number> = {
  configured: 1,
  unsupported: 2,
  missing: 3,
  stale: 4,
  error: 5,
};

function aggregateStatus(targets: AgentHookTargetHealth[]): AgentHookHealthStatus {
  return targets.reduce<AgentHookHealthStatus>(
    (current, target) => (STATUS_WEIGHT[target.status] > STATUS_WEIGHT[current] ? target.status : current),
    'configured',
  );
}

function targetsFor(health: AgentHookStatusResponse | null): AgentHookTargetHealth[] {
  return Array.isArray(health?.targets) ? health.targets : [];
}

function groupStatus(health: AgentHookStatusResponse | null, group: 'claude' | 'codex'): AgentHookHealthDisplayStatus {
  const allTargets = targetsFor(health);
  if (allTargets.length === 0) return 'unknown';
  const targets =
    group === 'codex'
      ? allTargets.filter((target) => target.name === 'codex-hooks')
      : allTargets.filter((target) => target.name !== 'codex-hooks');
  if (targets.length === 0) return 'unsupported';
  return aggregateStatus(targets);
}

function statusText(status: AgentHookHealthDisplayStatus): string {
  return STATUS_LABELS[status];
}

export function shouldRenderAgentHookHealthNotice({ health, error, syncing, synced }: RenderProbe): boolean {
  if ([error, syncing, synced].some(Boolean)) return true;
  return !!health && health.status !== 'configured';
}

function toneFor(status: AgentHookHealthStatus | 'syncing' | 'synced' | 'error') {
  if (['synced', 'configured'].includes(status)) {
    return {
      icon: 'check',
      title: 'Agent 运行 Hook 已同步',
      body: 'Claude/Codex 的开工与收尾 Hook 已就绪，猫猫可以按纪律开工。',
      classes: 'border-conn-green-ring bg-conn-green-bg text-conn-green-text',
    };
  }
  if (status === 'error') {
    return {
      icon: 'alert-triangle',
      title: 'Agent 运行 Hook 检测失败',
      body: '暂时无法确认 Hook 状态。可以稍后重试，或进入 Hub 继续诊断。',
      classes: 'border-conn-red-ring bg-conn-red-bg text-conn-red-text',
    };
  }
  if (status === 'syncing') {
    return {
      icon: 'wrench',
      title: '正在同步 Agent 运行 Hook',
      body: '正在写入 Cat Cafe 管理的 Hook 脚本和 settings 挂载项。',
      classes: 'border-conn-blue-ring bg-conn-blue-bg text-conn-blue-text',
    };
  }
  if (status === 'unsupported') {
    return {
      icon: 'info',
      title: 'Agent 运行 Hook 支持待确认',
      body: '当前环境有一部分 Hook 目录尚未启用；同步会尽量补齐，失败不影响项目治理初始化。',
      classes: 'border-conn-slate-ring bg-conn-slate-bg text-conn-slate-text',
    };
  }
  return {
    icon: 'alert-triangle',
    title: 'Agent 运行 Hook 需要同步',
    body: 'Hook 缺失或过期时，猫猫开工前的 recall 与收尾检查可能不会自动执行。',
    classes: 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text',
  };
}

function previewTargets(health: AgentHookStatusResponse | null): AgentHookTargetHealth[] {
  return targetsFor(health)
    .filter((target) => target.status !== 'configured')
    .slice(0, 5);
}

export function AgentHookHealthNotice({
  health,
  error,
  syncing = false,
  synced = false,
  onSync,
  className = '',
}: AgentHookHealthNoticeProps) {
  if (!shouldRenderAgentHookHealthNotice({ health, error, syncing, synced })) return null;

  const currentStatus = error ? 'error' : syncing ? 'syncing' : synced ? 'synced' : health ? health.status : 'error';
  const tone = toneFor(currentStatus);
  const problematicTargets = previewTargets(health);
  const canSync = !syncing && currentStatus !== 'synced';

  return (
    <div data-testid="agent-hook-health-notice" className={`rounded-lg border p-3 ${tone.classes} ${className}`}>
      <div className="flex items-start gap-3">
        <HubIcon name={tone.icon} className="h-5 w-5 flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{tone.title}</p>
              <p className="mt-1 text-xs opacity-85">{error ?? tone.body}</p>
            </div>
            {canSync && (
              <button
                type="button"
                onClick={() => void onSync()}
                className="min-w-[6.5rem] rounded-md bg-cocreator-primary px-3 py-1.5 text-xs font-medium text-cafe-white transition-colors hover:bg-cocreator-dark disabled:opacity-50"
              >
                一键同步
              </button>
            )}
            {syncing && <span className="text-xs font-medium">同步中...</span>}
          </div>

          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-full border border-cafe-subtle bg-cafe-surface-elevated px-2 py-0.5 text-cafe-secondary">
              Claude：{statusText(groupStatus(health, 'claude'))}
            </span>
            <span className="rounded-full border border-cafe-subtle bg-cafe-surface-elevated px-2 py-0.5 text-cafe-secondary">
              Codex：{statusText(groupStatus(health, 'codex'))}
            </span>
          </div>

          {problematicTargets.length > 0 && (
            <details className="mt-2 text-[11px]">
              <summary className="cursor-pointer font-medium">预览将修复的改动</summary>
              <ul className="mt-1 space-y-1">
                {problematicTargets.map((target) => (
                  <li
                    key={target.name}
                    className="rounded-md border border-cafe-subtle bg-cafe-surface-elevated px-2 py-1"
                  >
                    <span className="font-medium">{target.name}</span>
                    <span className="text-cafe-muted"> · {statusText(target.status)} · </span>
                    <span>{target.diff ? target.diff.message : target.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
