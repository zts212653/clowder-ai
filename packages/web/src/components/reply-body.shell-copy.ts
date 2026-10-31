import { defineShellCopy } from './shell/shell-copy';

/** Reply body controls and quote labels; authored text is never translated. */
export const replyBodyCopy = defineShellCopy(
  {
    zh: {
      showMore: (lines: number) => `展开（还有 ${lines} 行）`,
      showLess: '收起',
      quote: '引用',
      media: '作品',
      comment: '批注',
      reply: '回复',
      replyBy: (name: string) => `${name} 的回复`,
      executionRecord: '执行记录',
      tip: '提示',
      remove: (title: string) => `移除上下文 ${title}`,
      place: (number: number) => `第 ${number} 处`,
      unboundEdit: '未关联引用的修改',
      unversionedFileQuote: '无法确认当前位置',
      changedFileQuote: '原文已改',
    },
    en: {
      showMore: (lines: number) => `Show more (+${lines} lines)`,
      showLess: 'Show less',
      quote: 'Quote',
      media: 'Artwork',
      comment: 'Comment',
      reply: 'Reply',
      replyBy: (name: string) => `${name}'s reply`,
      executionRecord: 'Execution record',
      tip: 'Tip',
      remove: (title: string) => `Remove context ${title}`,
      place: (number: number) => `Reference ${number}`,
      unboundEdit: 'Changes without a linked reference',
      unversionedFileQuote: 'Current position cannot be confirmed',
      changedFileQuote: 'The source has changed',
    },
  },
  {
    samples: {
      showMore: [[1], [15]],
      replyBy: [['Astra'], ['缅因猫 Sol']],
      remove: [['Reply'], ["You's reply"]],
      place: [[1], [12]],
    },
  },
);
