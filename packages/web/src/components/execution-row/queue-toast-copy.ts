/**
 * F322 original-B: the words the queue's actions answer with. One home, so the old panel and the one-row
 * surface can never tell the user two different things about the same press.
 */
export function queuedGuidanceCopy(
  effective: string | undefined,
  fallbackReason: string | undefined,
  turnAccepted: boolean | undefined,
): string {
  if (effective === 'next_work') {
    return fallbackReason === 'parent_terminal_before_exposure'
      ? '原回复已结束，消息已转为下一条回复处理。'
      : '本次未追加到当前回复，消息已转为下一条回复处理。';
  }
  if (turnAccepted === false) {
    return '客户端尚未接受本轮回复，消息仍在队列中；客户端接受后会自动尝试追加。若一直未开始，可点 Stop 取消当前回复。';
  }
  if (turnAccepted === true) {
    return '消息仍在队列中，尚未确认追加成功；请按最新队列状态继续。';
  }
  return '消息仍在队列中，尚未确认客户端接收；请查看成员状态，若一直未开始，可点 Stop 取消当前回复。';
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
