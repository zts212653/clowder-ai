'use client';

import { useState } from 'react';
import type { RichCardBlock } from '@/stores/chat-types';
import { CommunityPublishFlow } from './CommunityPublishFlow';

export function isCommunityIssueDraftBlock(block: RichCardBlock, messageSource?: { connector?: string }): boolean {
  return block.meta?.kind === 'community_issue_draft' && !messageSource?.connector;
}

/** Agent proposals and confirmed execution failures share one preview/confirmation path. */
export function CommunityIssueDraftCard({ block, messageId }: { block: RichCardBlock; messageId?: string }) {
  const meta = block.meta as
    | {
        proposedTitle?: string;
        proposedBody?: string;
        proposedRepo?: string;
        proposedLabels?: string[];
        draftId?: string;
      }
    | undefined;
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return <p className="text-xs text-cafe-muted">已暂不提交</p>;
  return (
    <CommunityPublishFlow
      issueId={block.id}
      title={meta?.proposedTitle ?? block.title}
      bodyMarkdown={meta?.proposedBody ?? block.bodyMarkdown ?? ''}
      proposedRepo={meta?.proposedRepo}
      labels={meta?.proposedLabels}
      initialDraftId={meta?.draftId}
      source={{ sourceId: block.id, messageId }}
      status="confirmed"
      onStatusChange={() => {}}
      onDismiss={() => setDismissed(true)}
    />
  );
}
