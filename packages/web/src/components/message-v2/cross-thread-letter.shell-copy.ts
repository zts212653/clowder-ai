import { defineShellCopy } from '../shell/shell-copy';

export const crossThreadLetterCopy = defineShellCopy(
  {
    zh: {
      letter: '来信',
      from: (title: string) => `从「${title}」`,
      goToSource: '去原对话 ↗',
      titleUnreadable: '标题读不到',
      deleted: '一个已删除的对话',
      untitled: '未命名对话',
      you: '@你',
    },
    en: {
      letter: 'Letter',
      from: (title: string) => `From “${title}”`,
      goToSource: 'Go to source ↗',
      titleUnreadable: 'Title unavailable',
      deleted: 'A deleted conversation',
      untitled: 'Untitled conversation',
      you: '@you',
    },
  },
  { samples: { from: [['Design source'], ['设计源']] } },
);
