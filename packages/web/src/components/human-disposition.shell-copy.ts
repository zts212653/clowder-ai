import { HUMAN_DISPOSITION_REASON_COPY } from '../lib/human-disposition-feedback';
import { defineShellCopy } from './shell/shell-copy';
export const humanDispositionCopy = defineShellCopy({
  zh: {
    title: '为什么不采纳？',
    choose: '请选择最贴近的原因',
    detail: '补充原因',
    placeholder: '请用一句话说明',
    locked: '正在确认这一件现在的状态，稍候再提交。已填的内容会保留。',
    skip: '跳过原因',
    cancel: '取消',
    submitting: '提交中…',
    submit: '提交并拒绝',
    reasons: HUMAN_DISPOSITION_REASON_COPY,
  },
  en: {
    title: 'Why reject this?',
    choose: 'Choose the closest reason',
    detail: 'More detail',
    placeholder: 'Explain in one sentence',
    locked: 'Checking the current proposal. Your input is preserved.',
    skip: 'Skip reason',
    cancel: 'Cancel',
    submitting: 'Submitting…',
    submit: 'Submit and reject',
    reasons: {
      not_important: { label: 'Not important', hint: 'This does not need further work or retention.' },
      wrong_lane: { label: 'Wrong place', hint: 'Useful content, but it belongs elsewhere.' },
      bad_evidence: {
        label: 'Incorrect evidence',
        hint: 'The evidence is unreliable, incomplete or does not support this suggestion.',
      },
      not_now: { label: 'Not now', hint: 'The timing is not right.' },
      wrong: { label: 'Incorrect content', hint: 'This suggestion is inaccurate.' },
      other: { label: 'Other', hint: 'Explain the reason in one sentence.' },
    },
  },
});
