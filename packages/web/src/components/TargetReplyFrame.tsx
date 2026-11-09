'use client';
import type { ReactNode } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { usePluginTargets } from '@/hooks/usePluginMentionTargets';
import { CatAvatar } from './CatAvatar';
import { MessageBubble } from './MessageBubble';
import { PluginTargetIcon } from './PluginTargetIcon';
import { ReplyPlaceholder } from './ReplyPlaceholder';
import { type TargetReplyView, targetReplyNotice } from './target-response-projection';

/** One pending/empty-terminal frame for every participant. Identity is the only visual adapter. */
export function TargetReplyFrame({
  view,
  messageId,
  getCatById,
  children,
  timestamp,
  memberIdentity,
}: {
  view: TargetReplyView;
  messageId: string;
  getCatById: (id: string) => CatData | undefined;
  children?: ReactNode;
  timestamp: number;
  memberIdentity?: { avatar?: ReactNode; heading: ReactNode };
}) {
  const { knownTargets } = usePluginTargets();
  const plugin = knownTargets.find((target) => target.id === view.targetId);
  const member = getCatById(view.targetId);
  const state = view.status === 'waiting' ? 'awaiting_reply' : view.status;
  const avatar = memberIdentity ? (
    memberIdentity.avatar
  ) : view.backend === 'plugin' ? (
    <PluginTargetIcon icon={plugin?.icon} size={32} />
  ) : (
    <CatAvatar catId={view.targetId} size={32} />
  );
  const heading = memberIdentity?.heading ?? (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-semibold text-cafe-secondary">{plugin?.alias ?? member?.displayName ?? view.targetId}</span>
      <span className="text-cafe-muted">
        {new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
      </span>
    </div>
  );
  if (view.terminal)
    return (
      <MessageBubble messageId={messageId} avatar={avatar} header={heading}>
        <p>{targetReplyNotice(view.status)}</p>
        {children}
      </MessageBubble>
    );
  return (
    <ReplyPlaceholder messageId={messageId} targetId={view.targetId} state={state} avatar={avatar} heading={heading}>
      <p className={`mt-2 text-sm ${view.status === 'failed' ? 'text-conn-red-text' : 'text-cafe-muted'}`}>
        {targetReplyNotice(view.status)}
      </p>
      {children}
    </ReplyPlaceholder>
  );
}
