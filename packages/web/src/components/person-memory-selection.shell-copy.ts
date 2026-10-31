import { defineShellCopy } from './shell/shell-copy';
export const personMemorySelectionCopy = defineShellCopy(
  {
    zh: {
      unnamed: '未命名人物',
      notice: '逐项确认后才会写入；未勾选内容不会进入记忆或未来召回。',
      replacement: '这是纠正版；旧卡会被撤回，审批记录不会被原地改写。',
      select: (kind: string, draft: string) => `选择${kind}：${draft}`,
      original: '原话与证据',
      excerpt: (text: string) => `原话：“${text}”`,
      writing: '写入中…',
      selected: (n: number) => `写入已选 ${n} 项`,
      waiting: '稍候…',
      later: '稍后决定',
      cancelling: '取消中…',
      cancel: '取消这张卡',
      rejecting: '拒绝中…',
      reject: '拒绝',
    },
    en: {
      unnamed: 'Unnamed person',
      notice: 'Only selected drafts enter memory and future recall.',
      replacement: 'This is a correction. The earlier card is withdrawn and its decision history is preserved.',
      select: (kind: string, draft: string) => `Select ${kind}: ${draft}`,
      original: 'Original words and evidence',
      excerpt: (text: string) => `Original words: “${text}”`,
      writing: 'Writing…',
      selected: (n: number) => `Write ${n} selected`,
      waiting: 'Saving…',
      later: 'Decide later',
      cancelling: 'Cancelling…',
      cancel: 'Cancel this card',
      rejecting: 'Rejecting…',
      reject: 'Reject',
    },
  },
  {
    samples: {
      select: [
        ['事实', '喜欢爬山'],
        ['fact', 'Lives here'],
      ],
      excerpt: [['原话'], ['Original words']],
      selected: [[0], [1], [3]],
    },
  },
);
