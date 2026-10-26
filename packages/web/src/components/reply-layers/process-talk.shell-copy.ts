import { defineShellCopy } from '../shell/shell-copy';

export const processTalkCopy = defineShellCopy(
  {
    zh: {
      title: '回话里的过程话',
      note: '没有标明过程与回答的猫，按这个设置显示。只改变你的视图，原文保留，随时可展开。',
      whole: '整段显示',
      record: '收进执行记录',
      loading: '正在读取…',
      saving: '正在保存…',
      loadError: '暂时读不到设置，先整段显示。',
      saveError: '未能确认保存；当前仍显示之前的设置，可重新读取确认。',
      retry: '重新读取',
      earlier: (count: number) => `前面还有 ${count} 段话`,
    },
    en: {
      title: 'Process notes in replies',
      note: 'Applies to cats that do not label process notes and answers themselves. Changes your view only; the original text is kept and can always be expanded.',
      whole: 'Show whole reply',
      record: 'Move to execution record',
      loading: 'Loading…',
      saving: 'Saving…',
      loadError: 'Settings are unavailable. Showing whole replies for now.',
      saveError: 'Could not confirm the save. This view still uses the previous setting; reload to check.',
      retry: 'Reload settings',
      earlier: (count: number) => `${count} earlier text ${count === 1 ? 'section' : 'sections'}`,
    },
  },
  { samples: { earlier: [[1], [2]] } },
);
