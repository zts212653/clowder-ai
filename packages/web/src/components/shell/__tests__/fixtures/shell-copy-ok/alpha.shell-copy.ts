import { defineShellCopy } from '../../../shell-copy';

export const alphaCopy = defineShellCopy(
  {
    zh: { title: '成员', running: (count: number) => `运行中 ${count}` },
    en: { title: 'Members', running: (count: number) => `${count} running` },
  },
  { samples: { running: [[0], [1], [12]] } },
);
