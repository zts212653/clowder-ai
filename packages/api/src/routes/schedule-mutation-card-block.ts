import type { RichCardBlock, ScheduleMutationProposal } from '@cat-cafe/shared';

export function buildScheduleMutationCardBlock(proposal: ScheduleMutationProposal): RichCardBlock {
  const mutation = proposal.mutation;
  const task = mutation.kind === 'create' ? mutation.task : mutation.taskSnapshot;
  const verb = { create: '创建', delete: '永久删除', update: '更新' }[mutation.kind];
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
        : mutation.kind === 'update'
          ? '批准后更新以下参数；正在执行的任务继续使用原设置。'
          : '批准时会再次核对任务指纹；定义有漂移则拒绝删除。',
    tone: mutation.kind === 'delete' ? 'warning' : 'info',
    fields: [
      { label: 'Task ID', value: task.id },
      { label: 'Template', value: task.templateId },
      { label: 'Trigger', value: JSON.stringify(displayedTrigger) },
      { label: 'Delivery thread', value: task.deliveryThreadId ?? '（无）' },
      ...(mutation.kind === 'update'
        ? Object.entries(mutation.params)
            .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(task.params[key]))
            .map(([key, value]) => ({
              label: key,
              value: `${JSON.stringify(task.params[key]) ?? '（未设置）'} → ${JSON.stringify(value)}`,
            }))
        : []),
    ],
    actions: [
      {
        label: `批准并${verb}`,
        action: 'schedule:approve',
        payload: { proposalId: proposal.proposalId },
      },
      { label: '驳回', action: 'schedule:reject', payload: { proposalId: proposal.proposalId } },
    ],
  };
}
