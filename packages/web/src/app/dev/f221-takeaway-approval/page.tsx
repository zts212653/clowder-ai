import type { ApprovalHubItem } from '@cat-cafe/shared';
import { notFound } from 'next/navigation';
import { ApprovalItemCard } from '@/components/ApprovalItemCard';

const ITEM: ApprovalHubItem = {
  proposalId: 'f221-takeaway-preview',
  sourceFeatureId: 'F221',
  requesterCatId: 'codex6-sol',
  ownerUserId: 'preview-owner',
  resolution: 'open',
  materialization: { state: 'not_started' },
  summary: 'Taste [visual-quality]: 我们以为 You 喜欢有温度又清楚的画面。',
  detail: {
    takeaway: '我们以为 You 喜欢有温度又清楚的画面。',
    quote: '漂亮画要配好读的字体。',
    scene: '主星书房画面与手账字体一起评估。',
    dimension: 'visual-quality',
    tags: ['画面', '字体'],
    privacy: 'public',
  },
  navigation: {
    state: 'anchored',
    originRef: { kind: 'message', threadId: 'thread-f221-preview', messageId: 'message-f221-origin' },
    approvalCardRef: { threadId: 'thread-f221-preview', messageId: 'message-f221-card' },
  },
  inlineApprovable: true,
  createdAt: Date.UTC(2026, 8, 26, 12),
};

export default function F221TakeawayApprovalPreview() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <main className="min-h-screen bg-cafe-surface-canvas px-4 py-8 text-cafe">
      <div className="mx-auto max-w-2xl">
        <ApprovalItemCard item={ITEM} />
      </div>
    </main>
  );
}
