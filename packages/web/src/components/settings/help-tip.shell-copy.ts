import { defineShellCopy } from '../shell/shell-copy';

export const helpTipCopy = defineShellCopy(
  {
    zh: { about: (topic: string) => `关于${topic}`, close: '收起说明' },
    en: { about: (topic: string) => `About ${topic}`, close: 'Close explanation' },
  },
  { samples: { about: [['Default cat'], ['Storage']] } },
);
