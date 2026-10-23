import { defineShellCopy } from '@/components/shell/shell-copy';

export const proposalResultCopy = defineShellCopy({
  zh: {
    approved: '已同意',
    opened: '对话已开',
    effectUnknown: '实际结果尚未确认',
    declined: '已拒绝',
    open: '打开 ›',
    details: '展开提议详情',
    collapse: '收起提议详情',
    proposer: '谁提的',
  },
  en: {
    approved: 'Approved',
    opened: 'conversation opened',
    effectUnknown: 'Effect not yet confirmed',
    declined: 'Declined',
    open: 'Open ›',
    details: 'Show proposal details',
    collapse: 'Hide proposal details',
    proposer: 'Proposed by',
  },
});
