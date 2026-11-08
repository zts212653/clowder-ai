'use client';

import { useRef } from 'react';
import { usePluginTargets } from '@/hooks/usePluginMentionTargets';
import type { ChatMessage } from '@/stores/chat-types';
import { pluginDeliveryReceipt } from './message-dispatch-projection';
import { PluginTargetIcon } from './PluginTargetIcon';
import { pluginReplyFor } from './plugin-reply-state';
import { ReplyPlaceholder } from './ReplyPlaceholder';

/** A presentation of plugin delivery, never a member invocation or evidence of model generation. */
export function PluginReplyPending({
  message,
  messages,
  liveSince,
}: {
  message: ChatMessage;
  messages: readonly ChatMessage[];
  liveSince?: number;
}) {
  const { knownTargets } = usePluginTargets();
  const replied = useRef(false);
  const receipt = pluginDeliveryReceipt(message);
  if (!receipt) return null;
  if (pluginReplyFor(receipt.inputMessageId, receipt.targetId, messages)) replied.current = true;
  const sources = messages.filter((candidate) => candidate.id === receipt.inputMessageId);
  const source = sources.length === 1 ? sources[0] : undefined;
  const refs = source?.lifecycle?.dispatchRefs?.filter((ref) => ref.targetId === receipt.targetId) ?? [];
  // History has no reliable "still waiting" evidence. Only deliveries begun during
  // this mounted thread visit can own a live placeholder; a reload/page-in cannot revive it.
  if (
    liveSince === undefined ||
    message.timestamp < liveSince ||
    replied.current ||
    !source ||
    source.visibility === 'whisper' ||
    source.extra?.recall ||
    refs.length !== 1 ||
    refs[0]?.statusMessageId !== message.id ||
    !(receipt.phase === 'sending' || (receipt.phase === 'accepted' && receipt.accepted))
  )
    return null;
  const target = knownTargets.find((candidate) => candidate.id === receipt.targetId);
  return (
    <ReplyPlaceholder
      messageId={message.id}
      targetId={receipt.targetId}
      state={receipt.phase === 'sending' ? 'delivering' : 'awaiting_reply'}
      avatar={<PluginTargetIcon icon={target?.icon} size={32} />}
      heading={
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold text-cafe-secondary">{target?.alias ?? '插件'}</span>
          <span className="text-cafe-muted">Plugin</span>
        </div>
      }
    >
      <p className="mt-2 text-sm text-cafe-muted">{receipt.phase === 'sending' ? '正在投递…' : '已接收，等待回复…'}</p>
    </ReplyPlaceholder>
  );
}
