import type { CloudBindingRecoveryCardViewProps } from './CloudBindingRecoveryCard';

export function recoveryHeading(props: CloudBindingRecoveryCardViewProps): [string, string] {
  if (props.bindingOnly && props.phase === 'connected')
    return ['砚砚 Pro 已连接到这个对话', '会话已连接，这条猫猫消息没有重发。请让原猫重新召唤砚砚 Pro。'];
  if (props.deliveryStatus === 'sent') return ['已发送到 ChatGPT', '砚砚 Pro 已收到这条消息，回复会回到这里。'];
  if (props.deliveryStatus === 'failed')
    return ['这条消息未发送', `请处理投递提示中的问题后，重新 @${props.targetCatId} 发一条新消息。`];
  if (props.phase === 'binding') return ['正在连接砚砚 Pro…', '正在保存当前对话的连接。'];
  if (props.phase === 'retrying') return ['已连接，正在提交发送…', '正在继续发送原来的这条消息。'];
  if (
    props.phase === 'queued' ||
    (props.deliveryStatus === 'sending' && props.loadState.kind === 'loading') ||
    (props.loadState.kind === 'ready' && props.loadState.retryState === 'pending')
  )
    return ['消息已进入发送流程', '正在等待 ChatGPT 的送达确认。'];
  const connected = props.loadState.kind === 'ready' && props.loadState.boundConversationId !== null;
  if (props.loadState.kind === 'ready' && props.loadState.connectionIssue)
    return ['连接组件尚未就绪', props.loadState.connectionIssue];
  if (props.bindingOnly)
    return ['选择砚砚 Pro 要继续的对话', '这条猫猫消息还没有发送。请选择已授权会话；连接后请让原猫重新召唤。'];
  const title = connected ? '砚砚 Pro 已连接到这个对话' : '选择砚砚 Pro 要继续的对话';
  if (props.loadState.kind === 'loading') return [title, '正在读取会话与发送状态…'];
  if (props.deliveryStatus === 'unknown') return [title, '暂时无法确认原消息是否送达，请查看原对话。'];
  if (props.attemptId)
    return [
      title,
      connected ? '原消息尚未完成发送，可以继续发送。' : '这条消息还没有发送。请选择要连接的 ChatGPT 会话。',
    ];
  return [
    title,
    connected ? '后续在这里召唤砚砚 Pro，会继续使用已连接的会话。' : '连接后，在这里召唤砚砚 Pro 就会继续使用该会话。',
  ];
}
