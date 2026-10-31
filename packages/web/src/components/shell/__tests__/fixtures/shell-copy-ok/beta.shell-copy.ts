import { defineShellCopy } from '../../../shell-copy';

export const betaCopy = defineShellCopy(
  {
    zh: {
      group: { empty: '暂无内容', tool: 'Git' },
      // A Chinese pronoun that the English words as the neutral singular: the argument only picks wording, so it is declared.
      online: (gender: 'female' | 'male'): string => (gender === 'female' ? '她已上线' : '他已上线'),
    },
    en: {
      group: { empty: 'Nothing here yet', tool: 'Git' },
      online: (): string => 'They are online',
    },
  },
  { samples: { online: [['female'], ['male']] }, grammar: { online: ['0'] } },
);
