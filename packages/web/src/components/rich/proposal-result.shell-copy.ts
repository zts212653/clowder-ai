import { defineShellCopy } from '@/components/shell/shell-copy';

export const proposalResultCopy = defineShellCopy({
  zh: {
    superseded: '已被新提议替代',
    replacement: '查看新提议 ↓',
    replacementUnavailable: '未能打开新提议，请重试',
    approved: '已同意',
    opened: '对话已开',
    effectUnknown: '实际结果尚未确认',
    failed: '对话没开成',
    retry: '再试一次',
    declined: '已拒绝',
    open: '打开 ›',
    details: '展开提议详情',
    collapse: '收起提议详情',
    proposer: '谁提的',
  },
  en: {
    superseded: 'Replaced by a new proposal',
    replacement: 'View new proposal ↓',
    replacementUnavailable: 'Could not open the new proposal; retry',
    approved: 'Approved',
    opened: 'conversation opened',
    effectUnknown: 'Effect not yet confirmed',
    failed: 'The conversation did not open',
    retry: 'Try again',
    declined: 'Declined',
    open: 'Open ›',
    details: 'Show proposal details',
    collapse: 'Hide proposal details',
    proposer: 'Proposed by',
  },
});
