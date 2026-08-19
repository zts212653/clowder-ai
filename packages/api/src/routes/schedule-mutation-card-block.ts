import type { RichCardBlock, ScheduleMutationProposal } from '@cat-cafe/shared';

export function buildScheduleMutationCardBlock(proposal: ScheduleMutationProposal): RichCardBlock {
  const mutation = proposal.mutation;
  const task = mutation.kind === 'create' ? mutation.task : mutation.taskSnapshot;
  const verb = mutation.kind === 'create' ? '创建' : '永久删除';
  const displayedTrigger =
    mutation.kind === 'create' && mutation.relativeOnceDelayMs !== undefined
      ? { type: 'once', delayMs: mutation.relativeOnceDelayMs, relativeTo: 'approval' }
      : task.trigger;
  return {
    id: `schedule-mutation-${proposal.proposalId}`,
    kind: 'card',
    v: 1,
    title: `提议${verb}定时任务：${task.display.label}`,
    bodyMarkdown:
      mutation.kind === 'create'
        ? '批准后才会创建并注册该任务；当前尚未产生调度副作用。'
        : '批准时会再次核对任务指纹；定义有漂移则拒绝删除。',
    tone: mutation.kind === 'create' ? 'info' : 'warning',
    fields: [
      { label: 'Task ID', value: task.id },
      { label: 'Template', value: task.templateId },
      { label: 'Trigger', value: JSON.stringify(displayedTrigger) },
      { label: 'Delivery thread', value: task.deliveryThreadId ?? '（无）' },
    ],
    actions: [
      {
        label: mutation.kind === 'create' ? '批准并创建' : '批准并永久删除',
        action: 'schedule:approve',
        payload: { proposalId: proposal.proposalId },
      },
      { label: '驳回', action: 'schedule:reject', payload: { proposalId: proposal.proposalId } },
    ],
  };
}
