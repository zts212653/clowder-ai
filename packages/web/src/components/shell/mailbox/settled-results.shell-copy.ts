import { defineShellCopy } from '../shell-copy';

export const settledResultsCopy = defineShellCopy({
  zh: {
    title: '已处理的',
    recent: '最近 50 项；更早的结果在审批记录中',
    unavailable: '暂时无法读取已处理结果',
    sourceUnavailable: '暂时无法核对原提议；这份结果不提供决定操作。',
    reread: '重新读取',
    refreshing: '正在重新读取已处理结果…',
    preparing: '正在准备历史结果…',
  },
  en: {
    title: 'Handled',
    recent: 'Latest 50; earlier results are in approval records',
    unavailable: 'Handled results are unavailable',
    sourceUnavailable: 'The original proposal could not be verified. This receipt has no decision controls.',
    reread: 'Read again',
    refreshing: 'Refreshing handled results…',
    preparing: 'Preparing handled results…',
  },
});
