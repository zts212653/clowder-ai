export function dotActivationFeedback(
  status: { paired: boolean; subscription: 'active' | 'expired' | 'absent' } | null,
  tests: readonly { receivedAt?: number | null; readAt?: number | null; replyMessageId?: string | null }[],
): string {
  if (!status?.paired || status.subscription !== 'active')
    return '先在 ChatGPT 完成 dot 订阅，再回到这里测试两处往返；验证通过后才能启用 dot 协作。';
  if (!tests.length) return '请先点击「测试两处往返」，确认两处原对话都收到回复；验证通过后才能启用 dot 协作。';
  const pending = tests.flatMap((test, index) =>
    test.receivedAt && test.readAt && test.replyMessageId ? [] : [`测试 ${index === 0 ? 'A' : 'B'}`],
  );
  if (pending.length) return `${pending.join('、')}尚未完成读原文和原处回帖。请等待 dot 处理，完成后才能开启协作。`;
  return '两处回帖记录已返回，正在重新核对启用条件。';
}
