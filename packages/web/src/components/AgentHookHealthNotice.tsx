import type { AgentHookHealthStatus, AgentHookStatusResponse, AgentHookTargetHealth } from '@/hooks/useAgentHookHealth';
import { HubIcon } from './hub-icons';

export type { AgentHookStatusResponse } from '@/hooks/useAgentHookHealth';

interface AgentHookHealthNoticeProps {
  health: AgentHookStatusResponse | null;
  error?: string | null;
  syncing?: boolean;
  synced?: boolean;
  syncAttempted?: boolean;
  placement?: 'standalone' | 'project-setup';
  onSync: () => void | Promise<void>;
  className?: string;
}

interface RenderProbe {
  health: AgentHookStatusResponse | null;
  error?: string | null;
  syncing?: boolean;
  synced?: boolean;
  syncAttempted?: boolean;
}

type AgentHookHealthDisplayStatus = AgentHookHealthStatus | 'unknown';
type AgentHookNoticeStatus = AgentHookHealthStatus | 'syncing' | 'synced' | 'partial-sync' | 'error' | 'uninitialised';

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

type HealthGroup = 'claude' | 'codex' | 'gemini' | 'skills' | 'mcp';

function groupStatus(health: AgentHookStatusResponse | null, group: HealthGroup): AgentHookHealthDisplayStatus {
  const allTargets = targetsFor(health);
  if (allTargets.length === 0) return 'unknown';
  const peerNames = new Set(['codex-hooks', 'gemini-hooks', 'skills', 'mcp']);
  const targets =
    group === 'codex'
      ? allTargets.filter((target) => target.name === 'codex-hooks')
      : group === 'gemini'
        ? allTargets.filter((target) => target.name === 'gemini-hooks')
        : group === 'skills'
          ? allTargets.filter((target) => target.name === 'skills')
          : group === 'mcp'
            ? allTargets.filter((target) => target.name === 'mcp')
            : allTargets.filter((target) => !peerNames.has(target.name));
  if (targets.length === 0) return 'unsupported';
  return aggregateStatus(targets);
}

function statusText(status: AgentHookHealthDisplayStatus): string {
  return STATUS_LABELS[status];
}

export function shouldRenderAgentHookHealthNotice({
  health,
  error,
  syncing,
  synced,
  syncAttempted,
}: RenderProbe): boolean {
  if ([error, syncing, synced, syncAttempted].some(Boolean)) return true;
  return !!health && health.status !== 'configured';
}

function toneFor(status: AgentHookNoticeStatus) {
  if (['synced', 'configured'].includes(status)) {
    return {
      icon: 'check',
      title: 'Agent 运行环境已同步',
      body: 'Hook、Skills、MCP 配置已就绪，猫猫可以按纪律开工。',
      classes: 'border-conn-green-ring bg-conn-green-bg text-conn-green-text',
    };
  }
  if (status === 'error') {
    return {
      icon: 'alert-triangle',
      title: 'Agent 运行环境检测失败',
      body: '暂时无法确认运行环境状态。可以稍后重试，或进入 Hub 继续诊断。',
      classes: 'border-conn-red-ring bg-conn-red-bg text-conn-red-text',
    };
  }
  if (status === 'syncing') {
    return {
      icon: 'wrench',
      title: '正在同步 Agent 运行环境',
      body: '正在同步 Hook、Skills 和 MCP 配置。用户自定义内容不会被覆盖。',
      classes: 'border-conn-blue-ring bg-conn-blue-bg text-conn-blue-text',
    };
  }
  if (status === 'partial-sync') {
    return {
      icon: 'alert-triangle',
      title: 'Agent 运行环境部分同步',
      body: '同步已执行，但仍有配置需要处理。',
      classes: 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text',
    };
  }
  if (status === 'unsupported') {
    return {
      icon: 'info',
      title: 'Agent 运行环境支持待确认',
      body: '当前环境有一部分配置目录尚未启用；同步会尽量补齐，失败不影响项目治理初始化。',
      classes: 'border-conn-slate-ring bg-conn-slate-bg text-conn-slate-text',
    };
  }
  if (status === 'uninitialised') {
    return {
      icon: 'info',
      title: '该项目尚未初始化',
      body: uninitialisedBody('standalone'),
      classes: 'border-conn-slate-ring bg-conn-slate-bg text-conn-slate-text',
    };
  }
  return {
    icon: 'alert-triangle',
    title: 'Agent 运行环境需要同步',
    body: 'Hook、Skills 或 MCP 配置缺失或过期。同步会保留用户自定义内容。',
    classes: 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text',
  };
}

function previewTargets(health: AgentHookStatusResponse | null): AgentHookTargetHealth[] {
  return targetsFor(health)
    .filter((target) => target.status !== 'configured')
    .slice(0, 5);
}

function displayTargetName(name: string): string {
  if (name === 'skills') return 'Skills';
  if (name === 'mcp') return 'MCP';
  return name;
}

function partialSyncBody(targets: AgentHookTargetHealth[]): string {
  if (targets.length === 0) return '同步已执行，但仍有配置需要处理。';
  const summary = targets.map((target) => `${displayTargetName(target.name)}：${target.reason}`).join('；');
  return `同步已执行，但仍有配置需要处理：${summary}。`;
}

function resolveNoticeStatus({ health, error, syncing, synced, syncAttempted }: RenderProbe): AgentHookNoticeStatus {
  if (error) return 'error';
  if (syncing) return 'syncing';
  if (synced) return 'synced';
  if (health?.uninitialised) return 'uninitialised';
  if (syncAttempted && health?.status !== 'configured') return 'partial-sync';
  return health ? health.status : 'error';
}

function uninitialisedBody(placement: 'standalone' | 'project-setup'): string {
  return placement === 'project-setup'
    ? '先选择下方方式完成项目初始化；完成后再检查 Hook、Skills 和 MCP 配置。'
    : '这个项目还没完成 Clowder AI 初始化，因此暂不检查或同步运行环境配置。';
}

function AgentHookStatusPills({ health }: { health: AgentHookStatusResponse | null }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2 text-xs">
      <span className="rounded-full border border-cafe-subtle bg-cafe-surface-elevated px-2 py-0.5 text-cafe-secondary">
        Claude：{statusText(groupStatus(health, 'claude'))}
      </span>
      <span className="rounded-full border border-cafe-subtle bg-cafe-surface-elevated px-2 py-0.5 text-cafe-secondary">
        Codex：{statusText(groupStatus(health, 'codex'))}
      </span>
      <span className="rounded-full border border-cafe-subtle bg-cafe-surface-elevated px-2 py-0.5 text-cafe-secondary">
        Gemini：{statusText(groupStatus(health, 'gemini'))}
      </span>
      <span className="rounded-full border border-cafe-subtle bg-cafe-surface-elevated px-2 py-0.5 text-cafe-secondary">
        Skills：{statusText(groupStatus(health, 'skills'))}
      </span>
      <span className="rounded-full border border-cafe-subtle bg-cafe-surface-elevated px-2 py-0.5 text-cafe-secondary">
        MCP：{statusText(groupStatus(health, 'mcp'))}
      </span>
    </div>
  );
}

function ProblematicTargetsPreview({ targets }: { targets: AgentHookTargetHealth[] }) {
  if (targets.length === 0) return null;

  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer font-medium">预览将修复的改动</summary>
      <ul className="mt-1 space-y-1">
        {targets.map((target) => (
          <li key={target.name} className="rounded-md border border-cafe-subtle bg-cafe-surface-elevated px-2 py-1">
            <span className="font-medium">{target.name}</span>
            <span className="text-cafe-muted"> · {statusText(target.status)} · </span>
            <span>{target.diff ? target.diff.message : target.reason}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function AgentHookHealthNotice({
  health,
  error,
  syncing = false,
  synced = false,
  syncAttempted = false,
  placement = 'standalone',
  onSync,
  className = '',
}: AgentHookHealthNoticeProps) {
  if (!shouldRenderAgentHookHealthNotice({ health, error, syncing, synced, syncAttempted })) return null;

  const currentStatus = resolveNoticeStatus({ health, error, syncing, synced, syncAttempted });
  const tone = toneFor(currentStatus);
  const problematicTargets = previewTargets(health);
  const isUninitialised = currentStatus === 'uninitialised';
  const canSync = !syncing && currentStatus !== 'synced' && !isUninitialised;
  const body = isUninitialised
    ? uninitialisedBody(placement)
    : currentStatus === 'partial-sync'
      ? partialSyncBody(problematicTargets)
      : (error ?? tone.body);

  return (
    <div data-testid="agent-hook-health-notice" className={`rounded-lg border p-3 ${tone.classes} ${className}`}>
      <div className="flex items-start gap-3">
        <HubIcon name={tone.icon} className="h-5 w-5 flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{tone.title}</p>
              <p className="mt-1 text-xs opacity-85">{body}</p>
            </div>
            {canSync && (
              <button
                type="button"
                onClick={() => void onSync()}
                className="min-w-[6.5rem] rounded-md bg-cafe-accent px-3 py-1.5 text-xs font-medium text-cafe-white transition-colors hover:bg-cafe-interactive disabled:opacity-50"
              >
                一键同步
              </button>
            )}
            {syncing && <span className="text-xs font-medium">同步中...</span>}
          </div>

          {!isUninitialised && <AgentHookStatusPills health={health} />}
          {!isUninitialised && <ProblematicTargetsPreview targets={problematicTargets} />}
        </div>
      </div>
    </div>
  );
}
