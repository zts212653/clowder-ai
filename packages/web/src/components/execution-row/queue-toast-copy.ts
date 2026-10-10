/**
 * F322 original-B: the words the queue's actions answer with. One home, so the old panel and the one-row
 * surface can never tell the user two different things about the same press.
 */
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
