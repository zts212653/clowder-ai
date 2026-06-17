export type VisibleSystemInfoVariant = 'info' | 'a2a_followup';

export interface VisibleSystemInfoResult {
  content: string;
  variant: VisibleSystemInfoVariant;
}

const INTERNAL_SYSTEM_INFO_TELEMETRY_TYPES = new Set([
  'mcp_server_status',
  'resume_failure_stats',
  'strategy_allow_compress',
  'tool_activity',
  'turn_duration', // F230 P2: PTY carrier terminal event — silently consumed, never shown as bubble
  'silent_completion', // Internal diagnostic — cat completed without text; noise for users
  'context_briefing', // F148: Internal routing context for cats, not user-facing
]);

export function isInternalSystemInfoTelemetry(parsed: Record<string, unknown>): boolean {
  return typeof parsed?.type === 'string' && INTERNAL_SYSTEM_INFO_TELEMETRY_TYPES.has(parsed.type);
}

function formatPingpongTerminated(parsed: Record<string, unknown>): VisibleSystemInfoResult {
  const fromCatId = typeof parsed.fromCatId === 'string' ? parsed.fromCatId : 'unknown';
  const targetCatId = typeof parsed.targetCatId === 'string' ? parsed.targetCatId : 'unknown';
  const pairCount = typeof parsed.pairCount === 'number' ? parsed.pairCount : undefined;
  const rounds = pairCount ? ` ${pairCount} 轮` : '';
  return {
    content: `🏓 ${fromCatId} ↔ ${targetCatId} 已连续互相 @${rounds}，链路已熔断。`,
    variant: 'info',
  };
}

function formatRoleRejected(parsed: Record<string, unknown>): VisibleSystemInfoResult {
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
  const targetCatId = typeof parsed.targetCatId === 'string' ? parsed.targetCatId : 'unknown';
  const action = typeof parsed.action === 'string' ? parsed.action : '当前';
  return {
    content: reason || `⛔ @${targetCatId} 不接受 ${action} 任务。`,
    variant: 'info',
  };
}

export function formatVisibleSystemInfo(parsed: Record<string, unknown>): VisibleSystemInfoResult | null {
  if (parsed?.type === 'a2a_followup_available') {
    const mentions = parsed.mentions as Array<{ catId: string; mentionedBy: string }>;
    return {
      content: mentions.map((m) => `${m.mentionedBy} @了 ${m.catId}`).join('、'),
      variant: 'a2a_followup',
    };
  }

  if (parsed?.type === 'warning') {
    const warningText = typeof parsed.message === 'string' ? parsed.message : '';
    return {
      content: warningText ? `⚠️ ${warningText}` : '⚠️ Warning',
      variant: 'info',
    };
  }

  if (parsed?.type === 'a2a_pingpong_terminated') {
    return formatPingpongTerminated(parsed);
  }

  if (parsed?.type === 'a2a_role_rejected') {
    return formatRoleRejected(parsed);
  }

  return null;
}

/**
 * F210 H3 (砚砚 scope): 折叠单行 agy trajectory 进度文案，写入 catStatusDetails（per-cat），
 * 由 ThreadCatStatus 显示，**不**渲染为 system bubble（避免 per-step 刷屏，承接 H1-hotfix 的
 * 静默消费）。文案保守："AGY working · N steps · latest"，N=idx+1，latest 取后端 neutralLabel
 * 的语义部分（H3 后端 step_type 粗标签）。
 */
export function formatAgyProgressDetail(parsed: Record<string, unknown>): string {
  const idx = Number(parsed.idx);
  const steps = Number.isFinite(idx) && idx >= 0 ? idx + 1 : 1;
  const label = typeof parsed.label === 'string' ? parsed.label : '';
  const semantic = label.match(/\(([^)]+)\)/)?.[1]; // 后端 "(assistant activity)" 等语义标签
  const latest = semantic ?? 'activity';
  return `AGY working · ${steps} step${steps > 1 ? 's' : ''} · ${latest}`;
}
