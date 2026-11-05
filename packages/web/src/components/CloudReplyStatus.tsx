'use client';

import { type CloudReplyState, cloudReplyHeading } from './cloud-reply-state';
import { useMessageNavigation } from './thread-chat/MessageNavigationContext';

export function CloudReplyStatus({
  result,
  targetCatId,
  hostUnconfirmed,
}: {
  result: Exclude<CloudReplyState, { state: 'unverified' }>;
  targetCatId: string;
  hostUnconfirmed: boolean;
}) {
  const navigate = useMessageNavigation();
  return (
    <div role="status" data-cloud-logical-status={result.state} className="text-sm leading-6 text-cafe-secondary">
      <p>{cloudReplyHeading(targetCatId)}</p>
      {result.state === 'source_replied' ? (
        <p className="text-xs text-cafe-muted">这条消息已有回信；当前发送批次仍待核对。</p>
      ) : null}
      {hostUnconfirmed ? <p className="text-xs text-cafe-muted">本次浏览器 Host 回执未确认</p> : null}
      <button
        type="button"
        className="text-xs text-cafe-interactive hover:underline"
        onClick={() => navigate(result.replyMessageId, { loadIfNeeded: true })}
      >
        查看回复
      </button>
    </div>
  );
}
