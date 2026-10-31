import { defineShellCopy } from '../shell/shell-copy';

export const runtimeInteractionHeadingCopy = defineShellCopy(
  {
    zh: {
      approval: (title: string) => `需要你确认：${title}`,
      question: (title: string) => `需要你回答：${title}`,
      elicitation: (title: string) => `需要你补充：${title}`,
    },
    en: {
      approval: (title: string) => `Needs your approval: ${title}`,
      question: (title: string) => `Needs your answer: ${title}`,
      elicitation: (title: string) => `Needs your input: ${title}`,
    },
  },
  {
    samples: {
      approval: [['Run tests?'], ['Keep 原文']],
      question: [['Environment'], ['Keep 原文']],
      elicitation: [['Details'], ['Keep 原文']],
    },
  },
);
