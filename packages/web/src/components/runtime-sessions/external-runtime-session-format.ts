import type {
  ExternalRuntimeSessionBinding,
  ExternalRuntimeSessionLifecycle,
  ExternalRuntimeSessionListItem,
} from './external-runtime-session-types';

export type RuntimeLifecycleTone = 'active' | 'attention' | 'pending' | 'sealed' | 'neutral';

export interface RuntimeLifecycleBadge {
  label: string;
  tone: RuntimeLifecycleTone;
  className: string;
}

const LIFECYCLE_BADGES: Record<string, RuntimeLifecycleBadge> = {
  active: {
    label: '进行中',
    tone: 'active',
    className: 'bg-conn-green-bg text-conn-green-text',
  },
  runtime_seal_pending: {
    label: '封存中',
    tone: 'pending',
    className: 'bg-conn-amber-bg text-conn-amber-text',
  },
  runtime_conflict_pending: {
    label: '冲突待处理',
    tone: 'attention',
    className: 'bg-conn-red-bg text-conn-red-text',
  },
  sealed: {
    label: '已封存',
    tone: 'sealed',
    className: 'bg-cafe-surface-elevated text-cafe-secondary',
  },
};

const SEAL_REASON_LABELS: Record<string, string> = {
  oversized_retire: '上下文过大',
  user_initiated: '用户重置',
  empty_response: '空响应',
  tool_conflict: '工具冲突',
  runtime_disconnected: 'Runtime 断开',
};

export function formatRuntimeLabel(runtime: string): string {
  if (runtime === 'antigravity-desktop') return 'Antigravity Desktop';
  return runtime;
}

export function formatLifecycleBadge(lifecycle: ExternalRuntimeSessionLifecycle): RuntimeLifecycleBadge {
  return (
    LIFECYCLE_BADGES[lifecycle.state] ?? {
      label: lifecycle.state,
      tone: 'neutral',
      className: 'bg-cafe-surface-elevated text-cafe-muted',
    }
  );
}

export function formatSealReason(reason: string | undefined): string {
  if (!reason) return '—';
  return SEAL_REASON_LABELS[reason] ?? reason;
}

export function formatBindingLabel(binding: ExternalRuntimeSessionBinding): string {
  if (binding.mode === 'orphan_anchor') return 'IDE 直连';
  return 'Thread 绑定';
}

// F211-REG1: surface tells the user how the session was created — a Cat-Cafe @mention
// dispatch vs a direct IDE conversation. Both are now listed in the runtime panel.
export interface RuntimeSurfaceBadge {
  label: string;
  className: string;
}

export function formatSurfaceBadge(surface: string | undefined): RuntimeSurfaceBadge | null {
  if (surface === 'cat-cafe-dispatch') {
    return { label: 'Café 派发', className: 'bg-conn-blue-bg text-conn-blue-text' };
  }
  if (surface === 'ide-direct') {
    return { label: 'IDE 直连', className: 'bg-cafe-surface-elevated text-cafe-secondary' };
  }
  return null;
}

export function formatRuntimeSessionTitle(
  session: ExternalRuntimeSessionListItem,
  resolveCatName: (catId: string) => string = (catId) => catId,
): string {
  const title = session.title?.trim();
  if (title) return title;
  if (session.model) return `${resolveCatName(session.catId)} · ${session.model}`;
  // No title and no model is a real legal state — say so in human words.
  // The full runtimeSessionId stays recoverable in the row's 会话标识 details.
  return `${resolveCatName(session.catId)} · 未命名会话`;
}

/** Human labels for session policy strategies; unknown values stay as stored. */
const POLICY_STRATEGY_LABELS: Record<string, string> = {
  handoff: '接力',
  compress: '压缩',
  hybrid: '混合',
};

/** Human labels for session policy execution states; unknown values stay as stored. */
const POLICY_STATUS_LABELS: Record<string, string> = {
  active: '生效中',
  degraded: '降级',
  unavailable: '不可用',
};

const CAPABILITY_LABELS: Record<string, string> = {
  compression_signal: '压缩信号',
  managed_invocation_boundary: '托管调用边界',
};

export function formatPolicyStrategy(strategy: string): string {
  return POLICY_STRATEGY_LABELS[strategy] ?? strategy;
}

export function formatPolicyStatus(status: string): string {
  return POLICY_STATUS_LABELS[status] ?? status;
}

export function formatMissingCapabilities(missing: readonly string[]): string | null {
  if (missing.length === 0) return null;
  const labels = missing.map((capability) => CAPABILITY_LABELS[capability] ?? capability);
  return `缺少：${labels.join('、')}`;
}
