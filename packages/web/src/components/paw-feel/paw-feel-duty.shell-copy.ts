import { defineShellCopy } from '@/components/shell/shell-copy';

export const pawFeelDutyCopy = defineShellCopy(
  {
    zh: {
      signature: (excluded: string, preferred: string) =>
        `等待独立签署；排除报告猫 @${excluded} 自签${preferred ? ` · 首选 @${preferred}` : ''}`,
      blocker: (code: string, ref: string) => `阻塞 ${code} · ${ref}`,
      proposal: (id: string) => `等待 durable proposal ${id} 获批`,
      routed: (target: string) => `已移交至 ${target}，不代表已经修复`,
      pending: (target: string) => `等待 ${target} 接单`,
      staleProposal: (id: string) => `F128 proposal ${id} 当前不是 pending，需重新路由或显式阻塞`,
      duplicate: (id: string) => `重复于 ${id}`,
      binding: (owner: string, task: string, lease: string) => `由 @${owner} 负责 · 任务 ${task} · F167 lease ${lease}`,
      assignment: (owner: string, task: string) => `由 @${owner} 负责 · 任务 ${task} · 当前任务分配`,
      failedAssignment: '任务分配已变化，需要重新绑定',
      failedLease: '当前 active lease 复验失败',
      reason: (code: string) => `理由：${code}`,
      responsibilitySurface: '责任面',
    },
    en: {
      signature: (excluded: string, preferred: string) =>
        `Awaiting independent signature; reporting cat @${excluded} cannot sign${preferred ? ` · Preferred @${preferred}` : ''}`,
      blocker: (code: string, ref: string) => `Blocked: ${code} · ${ref}`,
      proposal: (id: string) => `Awaiting approval of durable proposal ${id}`,
      routed: (target: string) => `Transferred to ${target}; repair is not yet proven`,
      pending: (target: string) => `Awaiting acceptance by ${target}`,
      staleProposal: (id: string) =>
        `F128 proposal ${id} is no longer pending; routing or an explicit blocker is required`,
      duplicate: (id: string) => `Duplicate of ${id}`,
      binding: (owner: string, task: string, lease: string) =>
        `Responsible cat @${owner} · Task ${task} · F167 lease ${lease}`,
      assignment: (owner: string, task: string) => `Responsible cat @${owner} · Task ${task} · Current assignment`,
      failedAssignment: 'Task assignment changed; rebind required',
      failedLease: 'Active lease revalidation failed',
      reason: (code: string) => `Reason: ${code}`,
      responsibilitySurface: 'responsibility surface',
    },
  },
  {
    samples: {
      signature: [
        ['sol', ''],
        ['kimi', 'sol'],
      ],
      blocker: [
        ['missing', 'ref-a'],
        ['stale', 'ref-b'],
      ],
      proposal: [['proposal-a'], ['proposal-b']],
      routed: [['thread-a'], ['thread-b']],
      pending: [['thread-a'], ['thread-b']],
      staleProposal: [['proposal-a'], ['proposal-b']],
      duplicate: [['signal-a'], ['signal-b']],
      assignment: [
        ['sol', 'task-a'],
        ['kimi', 'task-b'],
      ],
      binding: [
        ['sol', 'task-a', 'lease-a'],
        ['kimi', 'task-b', 'lease-b'],
      ],
      reason: [['stale'], ['missing']],
    },
  },
);
