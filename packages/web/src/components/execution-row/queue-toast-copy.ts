/**
 * F322 original-B: the words the queue's actions answer with. One home, so the old panel and the one-row
 * surface can never tell the user two different things about the same press.
 */
import type { QueueReminderAttemptState } from '@cat-cafe/shared';

export const REMINDER_RESULT_COPY: Record<
  QueueReminderAttemptState,
  { type: 'success' | 'info'; title: string; message: string }
> = {
  requested: {
    type: 'success',
    title: '提醒已请求',
    message: '不会打断当前工作；猫会在安全断点收到提示。',
  },
  delivered: { type: 'info', title: '提醒已送达', message: '猫已收到提示，尚未读取消息正文。' },
  seen: { type: 'info', title: '提醒后已读取', message: '猫已在该轮完整读取这条消息。' },
  missed: { type: 'info', title: '提醒未赶上本轮', message: '该轮已结束；回执保留本次未送达结果。' },
};

export function reminderResultCopy(state: unknown) {
  return typeof state === 'string' && state in REMINDER_RESULT_COPY
    ? REMINDER_RESULT_COPY[state as QueueReminderAttemptState]
    : REMINDER_RESULT_COPY.requested;
}

export function recoveryNoStartCopy(refreshed: boolean, error: unknown) {
  if (typeof error === 'string') {
    return { type: refreshed ? ('info' as const) : ('error' as const), title: '队列未启动', message: error };
  }
  if (refreshed) {
    return {
      type: 'info' as const,
      title: '队列状态已刷新',
      message: '系统没有启动新的处理；请按当前条目显示的可用操作继续。',
    };
  }
  return {
    type: 'error' as const,
    title: '队列未启动',
    message: '系统没有启动新的处理，刷新也未完成；请稍后重试。',
  };
}
