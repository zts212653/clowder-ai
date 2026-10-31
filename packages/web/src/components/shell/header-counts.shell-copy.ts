import { defineShellCopy } from './shell-copy';

export const headerCountsCopy = defineShellCopy(
  {
    zh: {
      works: '作品',
      worksTip: '这条对话的作品',
      tasks: '毛线球',
      tasksTip: '这条对话的毛线球',
      taskDetail: (open: number, total: number) => `${open} 项未完成 · 共 ${total} 项`,
      accessibleName: (label: string, tip: string) => `${label}，${tip}`,
    },
    en: {
      works: 'Works',
      worksTip: 'Works in this conversation',
      tasks: 'Tasks',
      tasksTip: 'Tasks in this conversation',
      taskDetail: (open: number, total: number) => `${open} unfinished · ${total} total`,
      accessibleName: (label: string, tip: string) => `${label}, ${tip}`,
    },
  },
  {
    samples: {
      taskDetail: [
        [0, 0],
        [1, 2],
        [12, 20],
      ],
      accessibleName: [
        ['Works', 'Works in this conversation'],
        ['Tasks 1', 'Tasks in this conversation'],
      ],
    },
  },
);
