import { defineShellCopy } from '@/components/shell/shell-copy';

export const executionRecordDefaultCopy = defineShellCopy({
  zh: {
    title: '执行记录默认',
    scope: '决定每条回话的执行记录初次显示为收起还是展开；这条对话和单条回话仍可单独调整。',
    collapsed: { label: '收起', note: '先显示工具调用与耗时摘要' },
    expanded: { label: '展开', note: '直接显示完整执行记录' },
    loading: '正在读取执行记录默认…',
    loadFailed: '执行记录默认暂时没读到。',
    retry: '重试',
    saving: '正在保存…',
    saveFailed: '执行记录默认没有保存成功，请重试。',
  },
  en: {
    title: 'Activity default',
    scope:
      'Sets whether activity starts collapsed or expanded on each reply; conversation and per-reply choices can still override it.',
    collapsed: { label: 'Collapsed', note: 'Show the tool-call and duration summary first' },
    expanded: { label: 'Expanded', note: 'Show the full activity record immediately' },
    loading: 'Loading activity default…',
    loadFailed: "Activity default couldn't be loaded.",
    retry: 'Try again',
    saving: 'Saving…',
    saveFailed: 'Activity default could not be saved. Try again.',
  },
});
