import type { CatId, RichCardBlock } from '@cat-cafe/shared';
import type { AgentMessage, MessageMetadata } from '../../types.js';
import type { CodexAppServerRecoveryBlockedEvent } from './CodexAppServerRunner.js';

const REASON_COPY: Record<CodexAppServerRecoveryBlockedEvent['reason'], { title: string; body: string }> = {
  blocked_inflight_tool: {
    title: '自动续跑已安全暂停',
    body: '中断时仍有工具动作没有收到终态。系统保留了本轮断点，但不会猜测动作是否完成或自动重放。',
  },
  checkpoint_incomplete: {
    title: '自动续跑缺少可靠断点',
    body: '系统没有同时拿到本轮的明确任务坐标和最新计划，因此没有用一句模糊的“继续”替你选择任务。',
  },
  budget_exhausted: {
    title: '自动续跑暂未恢复',
    body: '本轮的有界容量恢复次数已经用完。系统保留了已知断点，未切换任务或扩大原授权。',
  },
};

function summarizePlan(event: CodexAppServerRecoveryBlockedEvent): string {
  const plan = event.checkpoint.latestPlan?.plan ?? [];
  if (plan.length === 0) return '未取得可靠计划快照';
  return plan
    .slice(0, 6)
    .map((item) => `${item.status === 'completed' ? '✓' : item.status === 'inProgress' ? '→' : '○'} ${item.step}`)
    .join('\n');
}

function summarizeTools(event: CodexAppServerRecoveryBlockedEvent): string {
  if (event.checkpoint.tools.length === 0) return '未观察到工具动作';
  return event.checkpoint.tools
    .slice(0, 5)
    .map((tool) => `${tool.status === 'terminal' ? '✓' : '…'} ${tool.type}: ${tool.label}`)
    .join('\n');
}

function diagnosticText(event: CodexAppServerRecoveryBlockedEvent): string {
  return JSON.stringify(
    {
      type: event.type,
      reason: event.reason,
      attempt: event.attempt,
      retryBudget: event.retryBudget,
      checkpoint: event.checkpoint,
    },
    null,
    2,
  );
}

export function buildCodexCapacityRecoveryCardMessage(input: {
  catId: CatId;
  metadata: MessageMetadata;
  event: CodexAppServerRecoveryBlockedEvent;
  timestamp?: number;
}): AgentMessage {
  const { catId, metadata, event, timestamp = Date.now() } = input;
  const copy = REASON_COPY[event.reason];
  const anchor = event.checkpoint.anchor;
  const nextStep =
    event.checkpoint.latestPlan?.plan.find((item) => item.status === 'inProgress')?.step ??
    event.checkpoint.latestPlan?.plan.find((item) => item.status === 'pending')?.step ??
    '等待可靠断点；不自动选择 thread 里的其他任务';
  const block = {
    id: `codex-capacity-recovery-${anchor?.invocationId ?? event.checkpoint.nativeThreadId ?? timestamp}`,
    kind: 'card',
    v: 1,
    title: copy.title,
    tone: 'warning',
    bodyMarkdown: copy.body,
    fields: [
      {
        label: '本轮任务',
        value: anchor
          ? `thread=${anchor.threadId}\ninvocation=${anchor.invocationId}\nmessages=${anchor.promptMessageIds.join(', ')}`
          : `nativeThread=${event.checkpoint.nativeThreadId ?? 'unknown'}`,
      },
      { label: '工作进度', value: summarizePlan(event) },
      { label: '系统观察到的工具动作', value: summarizeTools(event) },
      { label: '下一步', value: nextStep },
    ],
    actions: [
      {
        label: '复制断点诊断',
        action: 'copy-to-clipboard',
        payload: { text: diagnosticText(event) },
      },
    ],
    meta: {
      kind: 'codex_capacity_recovery',
      reason: event.reason,
      attempt: event.attempt,
      retryBudget: event.retryBudget,
      ...(anchor ? { threadId: anchor.threadId, invocationId: anchor.invocationId } : {}),
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
