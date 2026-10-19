import { defineShellCopy } from '../shell-copy';

export const personalActionCopy = defineShellCopy(
  {
    zh: {
      refreshing: '正在重新读取，请稍候。',
      saving: '正在保存，请稍候。',
      identity: '正在核实你的身份，请稍候。',
      preferences: '暂时无法确认你的忽略记录，请重试。',
      changed: '读取已更新或事项有变化，请刷新后重新确认。',
      source: (action: string) => `待办有一部分没读到，暂时不能${action}。`,
    },
    en: {
      refreshing: 'Refreshing. Please wait.',
      saving: 'Saving. Please wait.',
      identity: 'Verifying your identity. Please wait.',
      preferences: 'Your ignore preferences could not be verified. Please retry.',
      changed: 'The read or item changed. Refresh and confirm again.',
      source: (action: string) => `Some to-dos could not be read. ${action} is temporarily unavailable.`,
    },
  },
  { samples: { source: [['A'], ['B']] } },
);
