import { defineShellCopy } from '@/components/shell/shell-copy';
export const workSubmissionRecoveryCopy = defineShellCopy({
  zh: {
    title: '恢复这次交片',
    explanation: '核对这次交片后继续审片。已保存的版本会保留；尚未保存的提交会结束，之后可以重新交版。',
    checking: '正在核对…',
    resolve: '核对交片并恢复审片',
    failed: '提交暂时无法核对，请重试。',
  },
  en: {
    title: 'Recover this submission',
    explanation:
      'Check this submission to continue reviewing. Saved versions are kept; an unsaved submission will end and can be submitted again.',
    checking: 'Checking…',
    resolve: 'Check submission and resume review',
    failed: 'Could not check this submission. Please retry.',
  },
});
