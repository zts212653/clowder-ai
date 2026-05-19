import type { CatId, RichCardBlock } from '@cat-cafe/shared';
import type { AgentMessage, MessageMetadata } from '../../../types.js';
import type { AntigravitySideEffectJournalEntry } from './AntigravitySideEffectJournal.js';
import type { AntigravityRecoveryDecision } from './antigravity-recovery-policy.js';
import type { AntigravityResumeContext } from './antigravity-resume-context.js';

interface BuildRecoveryCardMessageInput {
  catId: CatId;
  metadata: MessageMetadata;
  recoveryDecision: AntigravityRecoveryDecision;
  resumeContext?: AntigravityResumeContext;
  error?: string;
  errorCode?: string;
  timestamp?: number;
}

function describeEffect(entry: AntigravitySideEffectJournalEntry): string {
  const target = entry.target ? `: ${entry.target}` : '';
  const status = entry.status === 'done' ? '已完成' : entry.status === 'failed' ? '失败' : '未确认';
  return `${status} ${entry.operation}${target}`;
}

function summarizeEffects(entries: AntigravitySideEffectJournalEntry[], emptyText: string): string {
  if (entries.length === 0) return emptyText;
  const visible = entries.slice(0, 3).map(describeEffect);
  if (entries.length > visible.length) {
    visible.push(`另有 ${entries.length - visible.length} 项`);
  }
  return visible.join('\n');
}

function buildDiagnosticId(resumeContext: AntigravityResumeContext): string {
  return `ag-rec-${resumeContext.cascadeId}-${resumeContext.interruptedAt}`;
}

function buildDiagnosticSummary(input: {
  diagnosticId: string;
  recoveryDecision: Extract<AntigravityRecoveryDecision, { action: 'surface_resumable_error' }>;
  resumeContext: AntigravityResumeContext;
  error: string;
  errorCode: string;
}): string {
  const completed = summarizeEffects(input.resumeContext.completedEffects, '无');
  const pending = summarizeEffects(input.resumeContext.pendingOrUnknownEffects, '无');
  return [
    `diagnosticId=${input.diagnosticId}`,
    `cascadeId=${input.resumeContext.cascadeId}`,
    `errorCode=${input.errorCode}`,
    `error=${input.error}`,
    `recoveryAction=${input.recoveryDecision.action}`,
    `recoveryReason=${input.recoveryDecision.reason}`,
    `instruction=${input.resumeContext.instruction}`,
    `completedEffects=${completed}`,
    `pendingOrUnknownEffects=${pending}`,
  ].join('\n');
}

export function buildAntigravityRecoveryCardMessage(input: BuildRecoveryCardMessageInput): AgentMessage | null {
  const {
    catId,
    metadata,
    recoveryDecision,
    resumeContext,
    error = 'unknown',
    errorCode = 'unknown',
    timestamp = Date.now(),
  } = input;
  if (recoveryDecision.action !== 'surface_resumable_error') {
    return null;
  }
  if (!resumeContext) {
    return null;
  }

  const diagnosticId = buildDiagnosticId(resumeContext);
  const diagnosticSummary = buildDiagnosticSummary({
    diagnosticId,
    recoveryDecision,
    resumeContext,
    error,
    errorCode,
  });

  const block = {
    id: `antigravity-recovery-${diagnosticId}`,
    kind: 'card',
    v: 1,
    title: 'Antigravity 恢复建议',
    tone: 'warning',
    bodyMarkdown:
      'Antigravity 在已经观察到可能写文件或执行工具的动作后连接中断。为避免重复副作用，我们已停止自动重试；请按下面建议继续。',
    fields: [
      {
        label: '已完成动作',
        value: summarizeEffects(resumeContext.completedEffects, '无'),
      },
      {
        label: '未完成动作',
        value: summarizeEffects(resumeContext.pendingOrUnknownEffects, '无'),
      },
      {
        label: '建议下一步',
        value: '继续未完成动作，不要重复已完成的 side effect。',
      },
      {
        label: '诊断 ID',
        value: diagnosticId,
      },
    ],
    actions: [
      {
        label: '复制诊断',
        action: 'copy-to-clipboard',
        payload: { text: diagnosticSummary },
      },
    ],
    meta: {
      kind: 'antigravity_recovery',
      diagnosticId,
      diagnosticSummary,
      cascadeId: resumeContext.cascadeId,
      recoveryDecision: {
        action: recoveryDecision.action,
        reason: recoveryDecision.reason,
      },
      completedEffectCount: resumeContext.completedEffects.length,
      pendingOrUnknownEffectCount: resumeContext.pendingOrUnknownEffects.length,
      errorCode,
    },
  } satisfies RichCardBlock;

  return {
    type: 'system_info',
    catId,
    content: JSON.stringify({ type: 'rich_block', block }),
    metadata,
    timestamp,
  };
}
