import { defineShellCopy } from '../shell/shell-copy';

/** F335 北极星稿 v1.5「界面上的字」: Dismiss / Undo / Resume / Hidden suggestions / Restore. */
export const suggestionCopy = defineShellCopy({
  zh: {
    dismiss: '忽略',
    undo: '撤销',
    resume: '恢复',
    dismissed: '已忽略',
    undone: '已撤销',
    resumed: '已恢复',
    failed: '没做成',
    hidden: '已隐藏的建议',
    restore: '恢复',
    kindVideoComments: '添加视频批注',
    kindScheduledTask: '创建定时任务',
  },
  en: {
    dismiss: 'Dismiss',
    undo: 'Undo',
    resume: 'Resume',
    dismissed: 'Dismissed',
    undone: 'Undone',
    resumed: 'Resumed',
    failed: "Didn't work",
    hidden: 'Hidden suggestions',
    restore: 'Restore',
    kindVideoComments: 'Add video comments',
    kindScheduledTask: 'Create scheduled task',
  },
});

export function suggestionKindLabel(
  copy: { kindVideoComments: string; kindScheduledTask: string },
  kind: string,
  fallback: string,
): string {
  if (kind === 'video-comments') return copy.kindVideoComments;
  if (kind === 'scheduled-task') return copy.kindScheduledTask;
  return fallback;
}
