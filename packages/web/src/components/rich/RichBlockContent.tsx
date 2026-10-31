'use client';

import { type ConnectorSource, isPersonMemoryProposalCardBlock } from '@cat-cafe/shared';
import { RichCardContent } from '@cat-cafe/ui';
import type { PublishedMessageCoordinate } from '@/components/content-review/usePublishedContent';
import { MarkdownContent } from '@/components/MarkdownContent';
import { isCorrectionPublication } from '@/components/memory/page/read-correction-approval';
import { MessageSearchAnswerCard } from '@/components/message-search/MessageSearchAnswerCard';
import { useShellCopy } from '@/components/shell/shell-copy';
import type { RichBlock } from '@/stores/chat-types';
import { AudioBlock } from './AudioBlock';
import { CallbackAuthFailureBlock } from './CallbackAuthFailureBlock';
import { CardBlock, type CardConfirmationEntry } from './CardBlock';
import { ChecklistBlock } from './ChecklistBlock';
import { CommunityIssueDraftCard, isCommunityIssueDraftBlock } from './CommunityIssueDraftCard';
import { CommunityIssuePreviewCard, isCommunityIssuePreviewBlock } from './CommunityIssuePreviewCard';
import { DiffBlock } from './DiffBlock';
import { isEvalRepairPublication } from './eval-repair-model';
import { FileBlock } from './FileBlock';
import { FrustrationIssueCard, isFrustrationIssueCardBlock } from './FrustrationIssueCard';
import { frustrationHistoryCopy } from './frustration-history.shell-copy';
import { trustedFrustrationMeta } from './frustration-visibility';
import { HandoffProposalCard, isHandoffProposalCardBlock } from './HandoffProposalCard';
import { HtmlWidgetBlock } from './HtmlWidgetBlock';
import { InteractiveBlock } from './InteractiveBlock';
import { LivingWorkCard } from './LivingWorkCard';
import { MediaGalleryBlock } from './MediaGalleryBlock';
import { OriginalDomainApprovalCard } from './OriginalDomainApprovalCard';
import { OriginalEvalRepairCard } from './OriginalEvalRepairCard';
import { OriginalMemoryCorrectionCard } from './OriginalMemoryCorrectionCard';
import { PersonMemoryProposalCard } from './PersonMemoryProposalCard';
import { isProposalCardBlock, ProposalCard } from './ProposalCard';
import { RuntimeConversationCard } from './RuntimeConversationCard';
import { isRuntimeInteractionCardBlock, RuntimeInteractionCard } from './RuntimeInteractionCard';
import { isDomainApprovalPublication } from './read-domain-approval-source';
import type { RuntimeConversationBinding } from './runtime-conversation-model';
import { isScheduleMutationProposalCardBlock, ScheduleMutationProposalCard } from './ScheduleMutationProposalCard';

function RichCardRenderer({
  block,
  messageId,
  messageSource,
  confirmations,
  publication,
  catId,
}: {
  block: Extract<RichBlock, { kind: 'card' }>;
  messageId?: string;
  messageSource?: ConnectorSource;
  confirmations?: CardConfirmationEntry[];
  publication?: PublishedMessageCoordinate;
  catId?: string;
}) {
  if (block.meta?.domain === 'message-search-answer')
    return <MessageSearchAnswerCard messageId={messageId} blockId={block.id} />;
  if (block.meta?.kind === 'work_reference')
    return <LivingWorkCard block={block} messageId={messageId} catId={catId} />;
  if (isDomainApprovalPublication(block)) return <OriginalDomainApprovalCard block={block} coordinate={publication} />;
  if (isCorrectionPublication(block)) return <OriginalMemoryCorrectionCard block={block} coordinate={publication} />;
  if (isEvalRepairPublication(block)) return <OriginalEvalRepairCard block={block} coordinate={publication} />;
  if (isPersonMemoryProposalCardBlock(block)) {
    return <PersonMemoryProposalCard block={block} messageId={messageId} coordinate={publication} />;
  }
  if (isRuntimeInteractionCardBlock(block)) {
    return <RuntimeInteractionCard block={block} messageId={messageId} />;
  }
  if (isProposalCardBlock(block)) return <ProposalCard block={block} messageId={messageId} coordinate={publication} />;
  if (isHandoffProposalCardBlock(block)) return <HandoffProposalCard block={block} messageId={messageId} />;
  if (isScheduleMutationProposalCardBlock(block)) {
    return <ScheduleMutationProposalCard block={block} coordinate={publication} messageId={messageId} />;
  }
  if (isFrustrationIssueCardBlock(block, messageSource)) {
    if (!trustedFrustrationMeta(block, messageSource?.connector)?.signal) return <UnknownFrustrationCard />;
    return <FrustrationIssueCard block={block} messageId={messageId} />;
  }
  if (isCommunityIssuePreviewBlock(block, messageSource)) {
    return <CommunityIssuePreviewCard block={block} messageId={messageId} />;
  }
  if (isCommunityIssueDraftBlock(block, messageSource)) {
    return <CommunityIssueDraftCard block={block} messageId={messageId} />;
  }
  const metaKind = (block.meta as { kind?: string } | undefined)?.kind;
  const isTrustedCallbackAuth = metaKind === 'callback_auth_failure' && messageSource?.connector === 'callback-auth';
  if (isTrustedCallbackAuth) return <CallbackAuthFailureBlock block={block} />;
  if (!block.meta && !block.actions?.length)
    return (
      <RichCardContent block={block} markdown={(source) => <MarkdownContent content={source} disableCommandPrefix />} />
    );
  return <CardBlock block={block} messageId={messageId} confirmations={confirmations} />;
}

function UnknownFrustrationCard() {
  const t = useShellCopy(frustrationHistoryCopy);
  return <p className="text-xs text-cafe-muted">{t.unknown}</p>;
}

export function RichBlockRenderer({
  block,
  publication,
  catId,
  messageId,
  sourceThreadId,
  sourceMessageIds,
  messageSource,
  confirmations,
  sendContext,
  htmlWidgetDisclosureKeys,
  runtimeInteractionCard,
}: {
  block: RichBlock;
  publication?: PublishedMessageCoordinate;
  catId?: string;
  messageId?: string;
  sourceThreadId?: string;
  sourceMessageIds?: readonly string[];
  messageSource?: ConnectorSource;
  confirmations?: CardConfirmationEntry[];
  /** F229 Bug 2 fix: propagated to InteractiveBlock to tag interactive-send events */
  sendContext?: string;
  htmlWidgetDisclosureKeys?: Readonly<Record<string, string>>;
  runtimeInteractionCard?: RuntimeConversationBinding;
}) {
  switch (block.kind) {
    case 'card':
      return (
        <RichCardRenderer
          block={block}
          messageId={messageId}
          messageSource={messageSource}
          confirmations={confirmations}
          publication={publication}
          catId={catId}
        />
      );
    case 'diff':
      return <DiffBlock block={block} />;
    case 'checklist':
      return <ChecklistBlock block={block} />;
    case 'media_gallery':
      return <MediaGalleryBlock block={block} publication={publication} />;
    case 'audio':
      return <AudioBlock block={block} catId={catId} />;
    case 'interactive':
      if (runtimeInteractionCard?.requestKind === 'conversation_decision')
        return (
          <RuntimeConversationCard
            block={block}
            binding={runtimeInteractionCard}
            messageId={messageId}
            sourceThreadId={sourceThreadId}
            catId={catId}
          />
        );
      return <InteractiveBlock block={block} messageId={messageId} sendContext={sendContext} />;
    case 'html_widget':
      return <HtmlWidgetBlock block={block} disclosureKey={htmlWidgetDisclosureKeys?.[block.id]} />;
    case 'file':
      return (
        <FileBlock
          block={block}
          publication={publication}
          messageId={messageId}
          sourceThreadId={sourceThreadId}
          sourceMessageIds={sourceMessageIds}
          catId={catId}
        />
      );
    default:
      return (
        <div className="rounded-lg border border-cafe px-3 py-2 text-xs text-cafe-muted">
          未知富块类型: {(block as { kind: string }).kind}
        </div>
      );
  }
}

/** A forwarded Rich Block is evidence, not a new execution surface. */
export function ReadOnlyRichBlockRenderer({ block }: { block: RichBlock }) {
  if (block.kind === 'card') {
    return <CardBlock block={{ ...block, actions: undefined, meta: undefined }} />;
  }
  if (block.kind === 'interactive') {
    return (
      <CardBlock
        block={{
          id: block.id,
          kind: 'card',
          v: 1,
          title: block.title ?? '交互选项',
          bodyMarkdown: block.description,
          fields: block.options.map((option) => ({ label: option.label, value: option.description ?? '' })),
        }}
      />
    );
  }
  if (block.kind === 'html_widget') {
    return (
      <CardBlock
        block={{
          id: block.id,
          kind: 'card',
          v: 1,
          title: block.title ?? 'HTML 小组件',
          bodyMarkdown: '这是转发的只读副本，不会运行原小组件。',
        }}
      />
    );
  }
  return <RichBlockRenderer block={block} />;
}
