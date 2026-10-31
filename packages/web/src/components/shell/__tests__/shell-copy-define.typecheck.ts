import { defineShellCopy } from '../shell-copy';

// Negative compilation samples, consumed by the existing Web tsconfig / formal tsc stage.
defineShellCopy({
  zh: { a: '甲', n: (count: number) => `${count}` },
  // @ts-expect-error en is missing `n`
  en: { a: 'A' },
});
defineShellCopy({
  zh: { a: '甲' },
  // @ts-expect-error en has a key zh does not
  en: { a: 'A', extra: 'B' },
});
defineShellCopy({
  zh: { n: (count: number) => `${count}` },
  // @ts-expect-error the parameter is a string in en and a number in zh
  en: { n: (count: string) => count },
});
defineShellCopy({
  zh: { a: '甲' },
  // @ts-expect-error a template where zh has plain text
  en: { a: (count: number) => `${count}` },
});
defineShellCopy(
  { zh: { online: (gender: 'female' | 'male') => gender }, en: { online: (gender: 'female' | 'male') => gender } },
  // @ts-expect-error an argument is named by its position ('0') or position and field ('1.gender'), not by its parameter name
  { grammar: { online: ['gender'] } },
);
