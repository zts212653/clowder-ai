export type VisibleSystemInfoVariant = 'info' | 'a2a_followup';

export interface VisibleSystemInfoResult {
  content: string;
  variant: VisibleSystemInfoVariant;
}

type ResolveCatName = (catId: string) => string;

const identityCatName: ResolveCatName = (catId) => catId;

const INTERNAL_SYSTEM_INFO_TELEMETRY_TYPES = new Set([
  'mcp_server_status',
  'resume_failure_stats',
  'strategy_allow_compress',
  'tool_activity',
  'turn_duration', // F230 P2: PTY carrier terminal event — silently consumed, never shown as bubble
  'context_briefing', // F148: Internal routing context for cats, not user-facing
]);

export function isInternalSystemInfoTelemetry(parsed: Record<string, unknown>): boolean {
  return typeof parsed?.type === 'string' && INTERNAL_SYSTEM_INFO_TELEMETRY_TYPES.has(parsed.type);
}

function formatPingpongTerminated(
  parsed: Record<string, unknown>,
  resolveCatName: ResolveCatName,
): VisibleSystemInfoResult {
  const fromCatId = typeof parsed.fromCatId === 'string' ? parsed.fromCatId : 'unknown';
  const targetCatId = typeof parsed.targetCatId === 'string' ? parsed.targetCatId : 'unknown';
  const pairCount = typeof parsed.pairCount === 'number' ? parsed.pairCount : undefined;
  const rounds = pairCount ? ` ${pairCount} 轮` : '';
  return {
    content: `🏓 ${resolveCatName(fromCatId)} ↔ ${resolveCatName(targetCatId)} 已连续互相 @${rounds}，链路已熔断。`,
    variant: 'info',
  };
}

function formatRoleRejected(parsed: Record<string, unknown>, resolveCatName: ResolveCatName): VisibleSystemInfoResult {
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
  const targetCatId = typeof parsed.targetCatId === 'string' ? parsed.targetCatId : 'unknown';
  const action = typeof parsed.action === 'string' ? parsed.action : '当前';
  return {
    content: reason || `⛔ ${resolveCatName(targetCatId)} 不接受 ${action} 任务。`,
    variant: 'info',
  };
}

function formatA2AFollowupAvailable(
  parsed: Record<string, unknown>,
  resolveCatName: ResolveCatName,
): VisibleSystemInfoResult | null {
  if (parsed?.type !== 'a2a_followup_available') return null;

  const mentions = parsed.mentions as Array<{ catId: string; mentionedBy: string }>;
  return {
    content: mentions.map((m) => `${resolveCatName(m.mentionedBy)} @了 ${resolveCatName(m.catId)}`).join('、'),
    variant: 'a2a_followup',
  };
}

function formatWarning(parsed: Record<string, unknown>): VisibleSystemInfoResult | null {
  if (parsed?.type !== 'warning') return null;

  const warningText = typeof parsed.message === 'string' ? parsed.message : '';
  return {
    content: warningText ? `⚠️ ${warningText}` : '⚠️ Warning',
    variant: 'info',
  };
}

export function formatSessionSealRequested(
  parsed: Record<string, unknown>,
  resolveCatName: ResolveCatName = identityCatName,
): VisibleSystemInfoResult | null {
  if (parsed?.type !== 'session_seal_requested') return null;

  const catId = typeof parsed.catId === 'string' ? parsed.catId : 'unknown';
  const sessionSeq = typeof parsed.sessionSeq === 'number' ? parsed.sessionSeq : '?';
  const healthSnapshot =
    typeof parsed.healthSnapshot === 'object' && parsed.healthSnapshot !== null
      ? (parsed.healthSnapshot as Record<string, unknown>)
      : undefined;
  const fillRatio = healthSnapshot?.fillRatio;
  const pct = typeof fillRatio === 'number' ? Math.round(fillRatio * 100) : '?';

  return {
    content: `${resolveCatName(catId)} 的会话 #${sessionSeq} 已封存（上下文 ${pct}%），下次调用将自动创建新会话`,
    variant: 'info',
  };
}

export function formatGovernanceBlocked(parsed: Record<string, unknown>): VisibleSystemInfoResult | null {
  if (parsed?.type !== 'governance_blocked') return null;

  const projectPath = typeof parsed.projectPath === 'string' ? parsed.projectPath : '';
  const reasonKind = typeof parsed.reasonKind === 'string' ? parsed.reasonKind : 'needs_bootstrap';

  return {
    content: `项目 ${projectPath} ${reasonKind === 'needs_bootstrap' ? '尚未初始化治理' : '治理状态异常'}`,
    variant: 'info',
  };
}

function formatModeSwitchProposal(
  parsed: Record<string, unknown>,
  resolveCatName: ResolveCatName,
): VisibleSystemInfoResult | null {
  if (parsed?.type !== 'mode_switch_proposal') return null;

  const by = typeof parsed.proposedBy === 'string' ? parsed.proposedBy : '猫猫';
  return {
    content: `${resolveCatName(by)} 提议切换到 ${parsed.proposedMode} 模式。`,
    variant: 'info',
  };
}

function formatInvocationPreempted(parsed: Record<string, unknown>): VisibleSystemInfoResult | null {
  if (parsed?.type !== 'invocation_preempted') return null;

  return {
    content: 'This response was superseded by a newer request.',
    variant: 'info',
  };
}

function formatSilentCompletion(
  parsed: Record<string, unknown>,
  resolveCatName: ResolveCatName,
  fallbackCatId?: string,
): VisibleSystemInfoResult | null {
  if (parsed?.type !== 'silent_completion') return null;

  const detail = typeof parsed.detail === 'string' ? parsed.detail : '';
  const catId = typeof parsed.catId === 'string' ? parsed.catId : (fallbackCatId ?? 'Cat');
  return {
    content: detail || `${resolveCatName(catId)} completed without a text response.`,
    variant: 'info',
  };
}

export function formatVisibleSystemInfo(
  parsed: Record<string, unknown>,
  resolveCatName: ResolveCatName = identityCatName,
  fallbackCatId?: string,
): VisibleSystemInfoResult | null {
  return (
    formatA2AFollowupAvailable(parsed, resolveCatName) ??
    formatWarning(parsed) ??
    (parsed?.type === 'a2a_pingpong_terminated' ? formatPingpongTerminated(parsed, resolveCatName) : null) ??
    (parsed?.type === 'a2a_role_rejected' ? formatRoleRejected(parsed, resolveCatName) : null) ??
    formatModeSwitchProposal(parsed, resolveCatName) ??
    formatInvocationPreempted(parsed) ??
    formatSilentCompletion(parsed, resolveCatName, fallbackCatId)
  );
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
