/**
 * Shared helper functions for RightStatusPanel and related components.
 */

export type IntentMode = 'execute' | 'ideate' | null;
export type CatStatus = 'pending' | 'streaming' | 'done' | 'error' | 'alive_but_silent' | 'suspected_stall';

export function modeLabel(mode: IntentMode): string {
  if (mode === 'ideate') return '独立观点采样';
  if (mode === 'execute') return '执行';
  return '空闲';
}

export function statusLabel(status: CatStatus): string {
  switch (status) {
    case 'pending':
      return '待命';
    case 'streaming':
      return '工作中';
    case 'done':
      return '完成';
    case 'error':
      return '异常';
    case 'alive_but_silent':
      return '静默等待';
    case 'suspected_stall':
      return '疑似卡住';
    default:
      return '未知';
  }
}

export function statusTone(status: CatStatus): string {
  switch (status) {
    case 'pending':
      return 'text-cafe-secondary';
    case 'streaming':
      return 'text-green-600';
    case 'done':
      return 'text-emerald-700';
    case 'error':
      return 'text-red-600';
    case 'alive_but_silent':
      return 'text-amber-500';
    case 'suspected_stall':
      return 'text-orange-600';
    default:
      return 'text-cafe-secondary';
  }
}

export function truncateId(id: string, len = 8): string {
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** F8: Format token count as compact string (e.g. 39270 → "39.3k") */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** F8: Format USD cost (e.g. 0.03 → "$0.03") */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}
