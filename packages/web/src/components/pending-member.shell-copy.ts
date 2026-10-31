import { defineShellCopy } from './shell/shell-copy';

/**
 * The active invocation proves receipt, not that a provider process has started.
 * Replace this line with the real reply as soon as output arrives.
 */
export const pendingMemberCopy = defineShellCopy({
  zh: {
    started: '已接下，还没有输出',
  },
  en: {
    started: 'Request received, no output yet',
  },
});
