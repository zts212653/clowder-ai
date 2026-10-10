'use client';

import {
  type CapabilityTipContext,
  companionIdentitySnapshotV1Schema,
  isCrossThreadProvenance,
  type LifecycleActiveRun,
} from '@cat-cafe/shared';
import { type CSSProperties, memo, type ReactNode } from 'react';
import { formatVisibleSystemInfo } from '@/hooks/system-info-visible';
import { type CatData, formatCatName } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { catColorVar, catSlug } from '@/lib/cat-slug';
import { CO_CREATOR_COLOR } from '@/lib/color-defaults';
import { hexToOklch } from '@/lib/color-utils';
import { getMentionRe, getMentionToCat } from '@/lib/mention-highlight';
import { parseDirection, parseImplicitStructuredTargets } from '@/lib/parse-direction';
import { CLASSIC_NAME_OPACITY } from '@/lib/readable-name-role';
import { resolveMessageSender } from '@/lib/resolve-sender';
import { type ChatMessage as ChatMessageType, resolveBubbleExpanded, useChatStore } from '@/stores/chatStore';
import { getMessageTimelineOrderTime, getOrderedMessageTimeline } from '@/stores/message-timeline';
import { setPendingCrossPostScroll } from '@/utils/crosspost-scroll-target';
import { AppendedInputReceipts } from './AppendedInputReceipts';
import {
  doesAssistantMessageRenderBubble,
  projectEmptyResponseLifecycleNotice,
} from './assistant-message-renderability';
import { CapabilityTipStrip } from './CapabilityTipStrip';
import { CatAvatar } from './CatAvatar';
import { CatNameplate } from './CatNameplate';
import { CloudBindingRecoveryCard } from './CloudBindingRecoveryCard';
import { CollapsibleMarkdown } from './CollapsibleMarkdown';
import { ConnectorBubble } from './ConnectorBubble';
import { ContentBlocks } from './ContentBlocks';
import { CopyIdButton } from './CopyIdButton';
import { isHiddenChatRow, projectSystemRowSurface } from './chat-row-surface';
import { CliOutputBlock } from './cli-output/CliOutputBlock';
import { toCliEvents } from './cli-output/toCliEvents';
import {
  hasCloudBindingRecoveryMetadata,
  isLinkedCloudBindingRecoveryNotice,
  projectCloudBindingRecovery,
} from './cloud-binding-recovery';
import { CompanionMessageAvatar, CompanionMessageIdentity } from './concierge/CompanionMessageIdentity';
import { ContentModificationSourceMessage } from './content-review/ContentModificationSourceMessage';
import { DirectionPill } from './DirectionPill';
import { EvidencePanel } from './EvidencePanel';
import { GovernanceBlockedCard } from './GovernanceBlockedCard';
import { ExternalLinkIcon } from './HubConfigIcons';
import { describeMessageInvocationTrajectory, InvocationTrajectoryAnchor } from './InvocationTrajectoryAnchor';
import { MessageActionSlot } from './MessageActionSlot';
import { MessageBubble } from './MessageBubble';
import { MessageBundleCard } from './MessageBundleCard';
import { MessageDispatchAvatars } from './MessageDispatchAvatars';
import { MetadataBadge } from './MetadataBadge';
import { buildMessageDisclosureKey, buildRichHtmlDisclosureKey } from './message-disclosure-state';
import { isConnectorSystemNotice } from './message-render-visibility';
import { isLastOfOwnRun } from './own-message-run';
import { PawFeelDispositionDock } from './paw-feel/PawFeelDispositionDock';
import { ReplyPill } from './ReplyPill';
import { RoutingWarningNotice } from './RoutingWarningNotice';
import { BriefingCard } from './rich/BriefingCard';
import type { CardConfirmationEntry } from './rich/CardBlock';
import { CustodyOfferCard } from './rich/CustodyOfferCard';
import { RichBlocks } from './rich/RichBlocks';
import { SubexecutionActivity } from './SubexecutionActivity';
import { SummaryCard } from './SummaryCard';
import { SystemNoticeBar } from './SystemNoticeBar';
import { useShellPresentation } from './shell/shell-presentation';
import { TerminalDiagnosticsPanel } from './TerminalDiagnosticsPanel';
import { ThinkingContent } from './ThinkingContent';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';

const BREED_STYLES: Record<string, { radius: string; font?: string }> = {
  ragdoll: { radius: 'rounded-2xl rounded-bl-sm' },
  'maine-coon': { radius: 'rounded-2xl rounded-br-sm', font: 'font-mono' },
  siamese: { radius: 'rounded-2xl rounded-tr-sm' },
};
const DEFAULT_BREED_STYLE = { radius: 'rounded-2xl' };
const EMPTY_TIMELINE_MESSAGES: readonly ChatMessageType[] = [];

/* catSlug helper moved to '@/lib/cat-slug' so other components can share it. */
const SCHEDULER_ACCENT_BADGE_CLASS =
  'inline-flex w-fit items-center gap-1.5 rounded-full border border-conn-amber-ring bg-conn-amber-bg px-2.5 py-1 text-xs font-semibold text-conn-amber-text shadow-sm';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const DELIVERED_AT_GAP_THRESHOLD = 5000;
function formatDualTime(timestamp: number, deliveredAt?: number): string {
  if (!deliveredAt || deliveredAt - timestamp <= DELIVERED_AT_GAP_THRESHOLD) {
    return formatTime(timestamp);
  }
  return `发送 ${formatTime(timestamp)} · 收到 ${formatTime(deliveredAt)}`;
}

function isSchedulerReplyPreview(replyPreview?: ChatMessageType['replyPreview']): boolean {
  return replyPreview?.senderCatId === 'system' && replyPreview.kind === 'scheduler_trigger';
}

function exactReplyPreview(
  message: ChatMessageType,
  timelineMessages: readonly ChatMessageType[],
): ChatMessageType['replyPreview'] | undefined {
  if (message.replyPreview?.deleted) return message.replyPreview;
  if (!message.replyTo) return message.replyPreview;
  const parents = timelineMessages.filter((candidate) => candidate.id === message.replyTo);
  if (parents.length !== 1) return message.replyPreview;
  const [parent] = parents;
  if (!parent) return undefined;
  const senderCatId = parent.from?.kind === 'agent' ? parent.from.catId : (parent.catId ?? null);
  return {
    ...message.replyPreview,
    from: parent.from,
    source: parent.source,
    senderCatId,
    content: message.replyPreview?.content ?? parent.content,
  };
}

interface ChatMessageProps {
  message: ChatMessageType;
  compact?: boolean;
  threadId?: string;
  timelineMessages?: readonly ChatMessageType[];
  activeRuns?: readonly LifecycleActiveRun[];
  getCatById: (id: string) => CatData | undefined;
  onEditCat?: (catId: string) => void;
  /** F056 follow-up: click co-creator avatar to open editor (consistent with cat avatar behavior). */
  onEditCoCreator?: () => void;
  /** F212 follow-up — UI-layer dedup for adjacent identical CliDiagnostics panels.
   *  When true, this message hides its CliDiagnosticsPanel entirely (an earlier adjacent
   *  message in the same dedup group already rendered the panel with a "×N" badge). The
   *  chat bubble itself, cat signature, and other content still render normally so the
   *  message audit trail stays intact. Computed at the message-list level via
   *  `utils/cli-diagnostics-dedup`. */
  hideDiagnosticsPanel?: boolean;
  /** F212 follow-up — when this is the head of a dedup group, the group's total size
   *  (head + N hidden subsequent duplicates). Passed through to CliDiagnosticsPanel for
   *  the "×N" badge rendering. */
  dedupCount?: number;
  /** The current browser document has not been admitted to perform forwarding writes. */
  forwardingDisabled?: boolean;
  /** This exact processing response owns the thread's single rotating capability tip. */
  showCapabilityTip?: boolean;
  capabilityTipContexts?: readonly CapabilityTipContext[];
  /** Routes interactive rich-block sends back to the surface that rendered this row. */
  sendContext?: string;
  confirmations?: CardConfirmationEntry[];
}

function needsTimelineProjection(message: ChatMessageType): boolean {
  return Boolean(
    hasCloudBindingRecoveryMetadata(message) ||
      message.extra?.turnExecution ||
      message.extra?.auxiliaryTurnExecutions?.length ||
      message.lifecycle?.dispatchRefs?.length ||
      (message.lifecycle?.kind === 'response' &&
        message.lifecycle.inputEntryIds.length > 1 &&
        message.lifecycle.inputMessageIds.length > 1) ||
      message.lifecycle?.kind === 'delivery_failure' ||
      message.replyTo ||
      (message.source?.connector === 'hold-ball' && typeof message.source.meta?.taskId === 'string') ||
      isSchedulerReplyPreview(message.replyPreview),
  );
}

function ChatMessageContent({
  message,
  compact = false,
  threadId,
  timelineMessages,
  getCatById,
  onEditCat,
  onEditCoCreator,
  hideDiagnosticsPanel,
  dedupCount,
  forwardingDisabled = false,
  showCapabilityTip = false,
  capabilityTipContexts,
  sendContext,
  confirmations,
}: ChatMessageProps) {
  // The Café 1.6 cat reply (nameplate, no outer bubble) is a presentation of the same message, switched by the one shell
  // switch. Read it with the other hooks, before any early return.
  const shellPresentation = useShellPresentation();
  const coCreator = useCoCreatorConfig();
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const renderThreadId = threadId ?? currentThreadId;
  const publication =
    renderThreadId && !message.isStreaming
      ? {
          threadId: renderThreadId,
          messageId: message.id,
          messageRevision: String(message.timestamp),
          origins: message.projectionPublicationOrigins,
        }
      : undefined;
  const disclosureThreadId = renderThreadId ?? 'default';
  const bodyDisclosureKey = buildMessageDisclosureKey(disclosureThreadId, message, 'body');
  const thinkingDisclosureKey = buildMessageDisclosureKey(disclosureThreadId, message, 'thinking');
  const cliDisclosureKey = buildMessageDisclosureKey(disclosureThreadId, message, 'cli');
  const richHtmlDisclosureKeys = Object.fromEntries(
    (message.extra?.rich?.blocks ?? [])
      .filter((block) => block.kind === 'html_widget')
      .map((block) => [block.id, buildRichHtmlDisclosureKey(disclosureThreadId, message, block)]),
  );
  const isLoadingThreads = useChatStore((s) => s.isLoadingThreads);
  const crossThreadSourceName = useChatStore((s) => {
    const sourceId = message.extra?.crossPost?.sourceThreadId;
    if (!sourceId) return undefined;
    return s.threads.find((thread) => thread.id === sourceId)?.title;
  });
  const threadMessages = useChatStore(
    (s) =>
      timelineMessages ??
      (needsTimelineProjection(message) ? getOrderedMessageTimeline(s.messages) : EMPTY_TIMELINE_MESSAGES),
  );
  const globalBubbleDefaults = useChatStore((s) => s.globalBubbleDefaults);
  const candidateSourceThreadId = message.extra?.crossPost?.sourceThreadId;
  const crossThreadSourceThreadId = isCrossThreadProvenance(candidateSourceThreadId, renderThreadId)
    ? candidateSourceThreadId
    : undefined;
  const sender = resolveMessageSender(message, getCatById, coCreator);
  const isUser = message.from?.kind === 'user';
  const isSystem = message.type === 'system';
  const isSummary = message.type === 'summary';
  const isConnector =
    message.from?.kind === 'external' || message.from?.kind === 'plugin' || message.type === 'connector';
  const cloudBindingRecovery = isUser ? projectCloudBindingRecovery(message, threadMessages) : undefined;
  const projectedSystemContent = message.extra?.systemInfo
    ? (formatVisibleSystemInfo(message.extra.systemInfo.payload, (catId) => resolveCatDisplayName(catId, getCatById))
        ?.content ?? message.content)
    : message.content;

  const catData = message.from?.kind === 'agent' ? getCatById(message.from.catId) : undefined;
  const parsedCompanionIdentity = companionIdentitySnapshotV1Schema.safeParse(message.extra?.liveCompanion?.identity);
  const companionIdentity =
    message.type === 'assistant' &&
    parsedCompanionIdentity.success &&
    (message.catId === parsedCompanionIdentity.data.live.catId ||
      message.catId === parsedCompanionIdentity.data.deep.catId)
      ? parsedCompanionIdentity.data
      : undefined;
  const companionAuthorName =
    companionIdentity && message.catId === companionIdentity.live.catId
      ? companionIdentity.live.displayName
      : companionIdentity?.deep.displayName;
  const catStyle = catData
    ? (() => {
        const breed = BREED_STYLES[catData.breedId ?? ''] ?? DEFAULT_BREED_STYLE;
        const label = sender.label;
        const isCallback = message.origin === 'callback';
        /* F056: Route bubble background through CSS vars so the OKLCH Tuner
         * (which writes --color-{slug}-surface) actually controls bubble color.
         * Previously bgColor was catData.color.secondary (raw catalog hex),
         * which bypassed the F056 token system entirely. */
        const slug = catSlug(catData.id);
        /* F056: Compute msg-hue/-chroma for .cat-persona-derived class so the
         * outer message wrapper provides --cat-msg-{bubble,surface,inset,...}
         * tokens used by nested ThinkingContent/CliOutputBlock. Without this,
         * those nested blocks render with --cat-msg-inset undefined → transparent. */
        let msgHue = 297; // fallback
        let msgChroma = 0.1;
        try {
          const oklch = hexToOklch(catData.color.primary);
          if (Number.isFinite(oklch.h) && Number.isFinite(oklch.c)) {
            msgHue = oklch.h;
            msgChroma = oklch.c;
          }
        } catch {
          /* fallback values already set */
        }
        return {
          label,
          radius: breed.radius,
          font: breed.font,
          /* F056 (co-creator 2026-05-28): post_message callback bubbles use the
           * SAME --color-{slug}-surface as normal bubbles. Previously isCallback
           * branched to tintedLight(hex, 0.08) — a hex-derived value that
           * bypassed the F056 token chain, so callback bubbles didn't follow
           * Tuner. Unified now: per-cat slug-keyed token drives both kinds. */
          bgColor: `var(--color-${slug}-surface)`,
          /* F056: cat name text color driven by Tuner's catText H/L/C slider.
           * This goes on the name span; message body text uses --cat-msg-text
           * (the msgText slider) via inline style on the bubble div instead. */
          textColor: catColorVar(catData.id, 'text'),
          /* F056: borderColor also routed through token via color-mix so Tuner
           * gradient propagates to bubble outline as well. Uses --color-{slug}-
           * ring (the existing ring tier already follows --cat-ring-l/cmul). */
          borderColor: isCallback
            ? `color-mix(in srgb, ${catColorVar(catData.id, 'ring')} 12%, transparent)`
            : `color-mix(in srgb, ${catColorVar(catData.id, 'ring')} 30%, transparent)`,
          msgHue,
          msgChroma,
        };
      })()
    : null;
  const currentThreadExists = useChatStore((s) => s.threads.some((thread) => thread.id === s.currentThreadId));
  const currentThreadBubbleThinking = useChatStore(
    (s) => s.threads.find((thread) => thread.id === s.currentThreadId)?.bubbleThinking,
  );
  const currentThreadBubbleCli = useChatStore(
    (s) => s.threads.find((thread) => thread.id === s.currentThreadId)?.bubbleCli,
  );
  const currentThreadThinkingMode = useChatStore(
    (s) => s.threads.find((thread) => thread.id === s.currentThreadId)?.thinkingMode,
  );
  const bubbleRestorePending = isLoadingThreads && !!currentThreadId && !currentThreadExists;
  const hasBlocks = message.contentBlocks && message.contentBlocks.length > 0;
  const hasTextContent = message.content.trim().length > 0;
  const isWhisper = message.visibility === 'whisper';
  const isRevealed = isWhisper && !!message.revealedAt;
  const resolvedReplyPreview = exactReplyPreview(message, threadMessages);
  const isSchedulerReply = isSchedulerReplyPreview(resolvedReplyPreview);
  const showSchedulerAccent =
    isSchedulerReply &&
    !threadMessages.some((candidate) => {
      if (candidate.id === message.id) return false;
      if (candidate.replyTo !== message.replyTo) return false;
      if (candidate.catId !== message.catId) return false;
      if (!isSchedulerReplyPreview(candidate.replyPreview)) return false;
      if (candidate.timestamp !== message.timestamp) {
        return candidate.timestamp < message.timestamp;
      }
      return candidate.id < message.id;
    });
  const subexecutionEvents = message.metadata?.subexecutionEvents ?? [];
  // Fetch optimization only: the API reuses the canonical parser and decides
  // whether this exact message owns a signal. Never use this sentinel as intake.
  const showPawFeelDisposition =
    !message.isStreaming && Boolean(message.catId) && message.content.includes('[爪感差') && !crossThreadSourceThreadId;
  const terminalTrajectory = describeMessageInvocationTrajectory(message);
  const showTerminalTrajectoryAnchor = terminalTrajectory && terminalTrajectory.status !== 'done';
  const renderCenteredTerminalSystemSurface = (content: ReactNode) => (
    <div data-message-id={message.id} className="group flex justify-center mb-3">
      <div className="max-w-[85%] w-full">
        {showTerminalTrajectoryAnchor && (
          <div className="mb-1 flex justify-center">
            <InvocationTrajectoryAnchor message={message} threadId={renderThreadId} />
          </div>
        )}
        {content}
      </div>
    </div>
  );

  const direction = catData
    ? parseDirection(message, () => ({ toCat: getMentionToCat(), re: getMentionRe() }), currentThreadId)
    : null;
  const implicitStructuredTargets = message.extra?.targetCats?.length
    ? parseImplicitStructuredTargets(message, () => ({ toCat: getMentionToCat(), re: getMentionRe() }))
    : [];

  const isFailedLifecycleResponse = message.lifecycle?.kind === 'response' && message.lifecycle.status === 'failed';
  const isStreamOrigin = message.origin === 'stream' && !isFailedLifecycleResponse;
  // F194 Phase Z11 follow-up: ordinary post_msg speech is projected as a
  // separate callback bubble, but exact-key callback_final records can still
  // merge into the stream bubble as terminal updates. Projection exposes the
  // origin-split portions on extra.stream so CLI Output keeps the stream
  // working log while the callback terminal text renders as the body.
  const mergedCliStdout = message.extra?.stream?.cliStdout;
  const mergedSpeechContent = message.extra?.stream?.speechContent;
  const cachedR21SpeechStdout =
    isStreamOrigin &&
    !message.isStreaming &&
    mergedCliStdout === '' &&
    message.content.trim().length === 0 &&
    typeof mergedSpeechContent === 'string' &&
    mergedSpeechContent.trim().length > 0
      ? mergedSpeechContent
      : undefined;
  const projectedCliStdout =
    isStreamOrigin && mergedCliStdout === '' && message.content.trim().length > 0 ? message.content : mergedCliStdout;
  const cliStdoutContent =
    cachedR21SpeechStdout ?? projectedCliStdout ?? (isStreamOrigin ? message.content : undefined);
  const cliEvents = toCliEvents(message.toolEvents, cliStdoutContent);
  const hasCliBlock = cliEvents.length > 0;
  const emptyResponseNotice = projectEmptyResponseLifecycleNotice(message, { hasCliBlock });
  const assistantPresentationTime =
    message.lifecycle?.kind === 'response' ? getMessageTimelineOrderTime(message) : message.timestamp;
  const cliStatus = message.isStreaming
    ? ('streaming' as const)
    : message.variant === 'error'
      ? ('failed' as const)
      : ('done' as const);
  if (isSummary && message.summary) {
    return (
      <div data-message-id={message.id}>
        <SummaryCard
          topic={message.summary.topic}
          conclusions={message.summary.conclusions}
          openQuestions={message.summary.openQuestions}
          createdBy={message.summary.createdBy}
          timestamp={message.timestamp}
        />
      </div>
    );
  }

  if (isSystem) {
    const surface = projectSystemRowSurface(message, threadMessages);
    switch (surface.kind) {
      case 'absorbed':
        return null;
      case 'briefing':
        return (
          <div data-message-id={message.id} className="flex justify-center mb-3">
            <div className="max-w-[85%] w-full opacity-80">
              <BriefingCard block={surface.block} messageId={message.id} />
            </div>
          </div>
        );
      case 'evidence':
        return <EvidencePanel data={surface.evidence} />;
      case 'governance_blocked':
        return (
          <GovernanceBlockedCard projectPath={surface.blocked.projectPath} reasonKind={surface.blocked.reasonKind} />
        );
      case 'diagnostics':
        // F212 follow-up — UI-layer dedup: a subsequent duplicate of an adjacent dedup group hides
        // its CLI panel (the group head already rendered it with a ×N badge). The empty wrapper
        // keeps data-message-id so MessageNavigator dots, ReplyPill jumps, and scrollToMessage
        // still resolve the anchor (codex review PR #1967 P2); h-0 keeps it at zero visual cost.
        if (surface.selected.kind === 'cli' && hideDiagnosticsPanel) {
          return <div data-message-id={message.id} aria-hidden="true" className="h-0" />;
        }
        return renderCenteredTerminalSystemSurface(
          <TerminalDiagnosticsPanel
            selected={surface.selected}
            errorMessage={message.content}
            dedupCount={dedupCount}
          />,
        );
    }

    // F045: variant='thinking' is deprecated — thinking is now embedded in assistant bubbles.
    const { isError } = surface;
    const isTool = message.variant === 'tool';
    const isFollowup = message.variant === 'a2a_followup';
    const toneClass = isTool
      ? 'text-cafe-muted bg-cafe-surface-elevated/50 font-mono text-xs py-1'
      : isFollowup
        ? 'text-[var(--color-cafe-accent)] bg-[var(--accent-50)] border border-purple-200'
        : isError
          ? 'text-conn-red-text bg-conn-red-bg rounded-full'
          : 'text-[var(--semantic-info)] bg-conn-blue-bg';
    return (
      <div data-message-id={message.id} className={`group flex justify-center ${isTool ? 'mb-1' : 'mb-3'}`}>
        <div className="max-w-[85%]">
          {showTerminalTrajectoryAnchor && (
            <div className="mb-1 flex justify-center">
              <InvocationTrajectoryAnchor message={message} threadId={renderThreadId} />
            </div>
          )}
          <div className={`text-sm px-4 py-2 rounded-lg whitespace-pre-wrap text-left ${toneClass}`}>
            {isFollowup && (
              <span className="mr-1 inline-flex align-text-bottom" aria-hidden="true">
                <ExternalLinkIcon />
              </span>
            )}
            {projectedSystemContent}
            {isFollowup && (
              <span className="block mt-1 text-xs text-[var(--color-cocreator-primary)]">
                输入 @猫名 跟进 来发起 follow-up
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (isConnector) {
    if (isConnectorSystemNotice(message)) {
      if (isLinkedCloudBindingRecoveryNotice(message, threadMessages)) return null;
      return <SystemNoticeBar message={message} />;
    }
    return <ConnectorBubble message={message} threadId={currentThreadId} timelineMessages={threadMessages} />;
  }

  // Zero-exposure recall is an invisible storage tombstone. History filtering
  // is authoritative; this guard keeps stale client caches from flashing it.
  if (isUser && message.extra?.recall?.exposure === 'none') return null;

  if (isUser) {
    const coCreatorPrimary = coCreator.color?.primary ?? CO_CREATOR_COLOR.primary;
    /* F056: cocreator slug-keyed (cocreator is in SLUGS, has its own per-cat
     * --color-cocreator-surface in cat-persona-tokens.css that follows the
     * shared --cat-surface-l/cmul gradient — same Tuner control surface as
     * other cats, but cocreator keeps its own hue/chroma). */
    const coCreatorBubbleBg = 'var(--color-cocreator-surface)';
    /* F056: cocreator bubble text uses the same --cat-msg-text as cat bubbles,
     * so the "消息文字" Tuner slider controls ALL message body text uniformly.
     * --color-cocreator-text (from catTxt/catText slider) is reserved for the
     * cocreator name span, not the message body. */
    const coCreatorBubbleText = 'var(--cat-msg-text)';
    /* F056: also wire cocreator hue/chroma to --msg-* so .cat-persona-derived
     * provides --cat-msg-{inset,inset-text} for nested ThinkingContent etc. */
    let coCreatorMsgHue = 40;
    let coCreatorMsgChroma = 0.13;
    try {
      const oklch = hexToOklch(coCreatorPrimary);
      if (Number.isFinite(oklch.h) && Number.isFinite(oklch.c)) {
        coCreatorMsgHue = oklch.h;
        coCreatorMsgChroma = oklch.c;
      }
    } catch {
      /* fallback values already set */
    }
    const userAvatar = (
      <button
        type="button"
        onClick={onEditCoCreator}
        className={`w-8 h-8 rounded-full overflow-hidden flex-shrink-0 ring-2 flex items-center justify-center text-xs font-bold text-[var(--cafe-surface)] ${onEditCoCreator ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
        style={{
          backgroundColor: 'var(--color-cocreator-primary)',
          boxShadow: '0 0 0 2px var(--color-cocreator-surface)',
        }}
        aria-label={`编辑 ${coCreator.name}`}
      >
        {coCreator.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coCreator.avatar}
            alt={coCreator.name}
            width={32}
            height={32}
            className="object-cover w-full h-full"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          'ME'
        )}
      </button>
    );

    /* F322 B segment 1 (human message). In the new presentation your own message is right-aligned with no avatar and no
     * signature (DESIGN.md「对话」: alone in the Café, right-aligned is you). What you could do with the message stays: the
     * action anchor, the whisper / reply marks, the copy-id control. The header is only as tall as the marks it holds, so a
     * plain message has no empty row above it; the copy-id control sits in the blank to the left of the block. */
    const humanPresentation = shellPresentation === 'v2' && !compact;
    const humanHasMarks = isWhisper || Boolean(message.replyTo && resolvedReplyPreview && !isSchedulerReply);
    // The human colour's light step. With no colour configured the role is the shared cocoa (shell-v2.css bakes its hue and
    // chroma, and CoCreatorHueInjector replaces them when the config has one), so there is no separate neutral fallback.
    const humanFill = 'var(--color-cocreator-surface)';
    const humanHeader = (
      <div
        data-testid="human-message-header"
        className={`relative flex w-full justify-end items-center gap-2${humanHasMarks ? ' mb-1' : ''}`}
      >
        <span className="absolute right-full top-0 mr-1">
          <CopyIdButton messageId={message.id} />
        </span>
        <MessageActionSlot />
        {isWhisper && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${isRevealed ? 'bg-cafe-surface-elevated text-cafe-secondary' : 'bg-semantic-warning-surface text-semantic-warning'}`}
          >
            {isRevealed ? '已揭秘' : `悄悄话 → ${message.whisperTo?.join(', ') ?? ''}`}
          </span>
        )}
        {message.replyTo && resolvedReplyPreview && !isSchedulerReply && (
          <ReplyPill replyPreview={resolvedReplyPreview} replyToId={message.replyTo} getCatById={getCatById} />
        )}
      </div>
    );
    /* A run of your own messages shows its time once, under the last one. */
    const humanTime =
      humanPresentation &&
      isLastOfOwnRun(message, timelineMessages ?? EMPTY_TIMELINE_MESSAGES, { currentThreadId: renderThreadId }) ? (
        <div data-testid="human-message-time" className="mt-1 text-xs" style={{ color: 'var(--shell-muted)' }}>
          {formatDualTime(message.timestamp, message.deliveredAt)}
        </div>
      ) : undefined;

    const userHeader = humanPresentation ? (
      humanHeader
    ) : (
      <div className="flex justify-end items-center gap-2 mb-1">
        <MessageActionSlot />
        {isWhisper && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${isRevealed ? 'bg-cafe-surface-elevated text-cafe-secondary' : 'bg-semantic-warning-surface text-semantic-warning'}`}
          >
            {isRevealed ? '已揭秘' : `悄悄话 → ${message.whisperTo?.join(', ') ?? ''}`}
          </span>
        )}
        {message.replyTo && resolvedReplyPreview && !isSchedulerReply && (
          <ReplyPill replyPreview={resolvedReplyPreview} replyToId={message.replyTo} getCatById={getCatById} />
        )}
        <span className="text-xs text-cafe-muted">{formatDualTime(message.timestamp, message.deliveredAt)}</span>
        <span className="text-xs font-semibold" style={{ color: 'var(--color-cocreator-primary)' }}>
          {coCreator.name}
        </span>
      </div>
    );

    const whisperActive = isWhisper && !isRevealed;
    const recalledAfterExposure = message.extra?.recall?.exposure === 'seen';

    return (
      <MessageBubble
        messageId={message.id}
        align="right"
        presentation={humanPresentation ? 'human' : 'bubble'}
        maxWidth={compact ? 'max-w-[86%]' : undefined}
        avatar={userAvatar}
        header={userHeader}
        footer={
          <>
            {humanTime}
            <RoutingWarningNotice warnings={message.extra?.routingWarnings} />
          </>
        }
        wrapperClassName="group cat-persona-derived"
        wrapperStyle={{ '--msg-hue': coCreatorMsgHue, '--msg-chroma': coCreatorMsgChroma } as CSSProperties}
        bubbleRadius="rounded-2xl rounded-br-sm"
        bubbleClassName={
          whisperActive
            ? 'bg-semantic-warning-surface text-semantic-warning border border-dashed border-semantic-warning'
            : compact
              ? 'ml-auto w-fit max-w-full border border-cafe-subtle'
              : ''
        }
        bubbleStyle={
          !whisperActive
            ? {
                backgroundColor: humanPresentation ? humanFill : coCreatorBubbleBg,
                color: compact ? 'var(--cafe-text)' : coCreatorBubbleText,
              }
            : undefined
        }
      >
        {!recalledAfterExposure && message.extra?.contentModificationRequestV1 ? (
          <ContentModificationSourceMessage metadata={message.extra.contentModificationRequestV1} />
        ) : null}
        {recalledAfterExposure ? (
          <div data-recalled-message="seen" className="text-xs text-cafe-muted">
            <div className="font-medium text-cafe-secondary">已撤回 · 曾读取</div>
            {message.extra?.recall?.exposures?.length ? (
              <div className="mt-1">
                {message.extra.recall.exposures
                  .map((exposure) => {
                    const cat = getCatById(exposure.targetCatId);
                    return cat ? formatCatName(cat) : exposure.targetCatId;
                  })
                  .join(' · ')}
              </div>
            ) : null}
          </div>
        ) : message.extra?.messageBundle ? (
          <MessageBundleCard
            messageId={message.id}
            forwarderName={coCreator.name}
            getCatLabel={(catId) => {
              const cat = getCatById(catId);
              return cat ? formatCatName(cat) : catId;
            }}
          />
        ) : hasBlocks ? (
          <ContentBlocks blocks={message.contentBlocks!} publication={publication} />
        ) : (
          <CollapsibleMarkdown content={message.content} disclosureKey={bodyDisclosureKey} />
        )}
        {cloudBindingRecovery && renderThreadId ? (
          <CloudBindingRecoveryCard
            threadId={renderThreadId}
            sourceMessageId={message.id}
            targetCatId={cloudBindingRecovery.targetCatId}
            attemptId={cloudBindingRecovery.attemptId}
            deliveryStatus={cloudBindingRecovery.deliveryStatus}
          />
        ) : null}
        {message.extra?.custodyOfferV1 ? (
          <CustodyOfferCard sourceMessageId={message.id} expectedOffer={message.extra.custodyOfferV1} />
        ) : null}
      </MessageBubble>
    );
  }

  // Keep the real bubble and pending placeholder on the same visual predicate.
  // Identity/lifecycle metadata alone must not tear down the placeholder before
  // an assistant avatar and frame can actually take over.
  const assistantRenderContext = {
    currentThreadId: renderThreadId,
    hasCliBlock,
    hasCrossThreadSource: Boolean(crossThreadSourceThreadId),
  };
  if (!doesAssistantMessageRenderBubble(message, assistantRenderContext)) {
    const notice = emptyResponseNotice;
    if (notice?.tone === 'processing') {
      return (
        <div data-message-id={message.id} data-testid="response-lifecycle-tip" className="mb-4 flex items-start gap-2">
          {catData ? <CatAvatar catId={catData.id} size={32} status="streaming" /> : null}
          <div className="min-w-0 flex-1 pt-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold" style={{ color: catStyle?.textColor }}>
                {catStyle?.label ?? sender.label}
              </span>
              <span className="text-cafe-muted">{formatTime(assistantPresentationTime)}</span>
            </div>
            {showCapabilityTip && capabilityTipContexts ? (
              <CapabilityTipStrip
                surface="pending_bubble"
                contexts={capabilityTipContexts}
                audience="cvo"
                enabled
                firstDelayMs={0}
              />
            ) : (
              <output className="mt-1 inline-flex items-center gap-0.5 py-2 text-sm text-cafe-muted">
                <span className="sr-only">处理中</span>
                <span className="animate-bounce" style={{ animationDelay: '0ms' }} aria-hidden="true">
                  ·
                </span>
                <span className="animate-bounce" style={{ animationDelay: '150ms' }} aria-hidden="true">
                  ·
                </span>
                <span className="animate-bounce" style={{ animationDelay: '300ms' }} aria-hidden="true">
                  ·
                </span>
              </output>
            )}
          </div>
        </div>
      );
    }
    return null;
  }

  /* F322 B segment 1: in the Café 1.6 presentation a cat's ordinary reply is a nameplate over unframed text.
   * Everything that already has its own look stays on the old path: compact replies, the live companion's identity, and
   * a message whose cat the registry does not know. The user, connector and system branches returned above. */
  const showsNameplate = shellPresentation === 'v2' && !compact && !companionIdentity && !!catStyle;

  /* ── Cat (assistant) header ── */
  const catHeader =
    compact ||
    catStyle ||
    companionIdentity ||
    message.extra?.turnExecution ||
    message.extra?.auxiliaryTurnExecutions?.length ||
    subexecutionEvents.length ? (
      <div
        className="mb-1 flex flex-col gap-1 min-w-0"
        data-testid="message-header"
        data-turn-execution-owner={message.extra?.turnExecution?.invocationId}
      >
        <div className="flex items-center gap-2 min-w-0">
          {showsNameplate && catData && catStyle ? (
            <>
              <CatNameplate
                catId={catData.id}
                name={catStyle.label}
                streaming={message.isStreaming}
                onEditCat={onEditCat && catData ? () => onEditCat(catData.id) : undefined}
              />
              <span
                data-testid="cat-nameplate-time"
                className="text-xs shrink-0"
                style={{ color: 'var(--shell-muted)' }}
              >
                {formatTime(assistantPresentationTime)}
              </span>
            </>
          ) : (
            <>
              <span
                className="text-xs font-semibold truncate max-w-[140px] sm:max-w-[200px] md:max-w-[280px]"
                style={{ color: catStyle?.textColor, opacity: CLASSIC_NAME_OPACITY }}
                title={
                  companionIdentity
                    ? `猫猫球 · ${companionIdentity.partner.displayName}`
                    : (catStyle?.label ?? sender.label)
                }
              >
                {companionIdentity
                  ? `猫猫球 · ${companionIdentity.partner.displayName}`
                  : (catStyle?.label ?? sender.label)}
              </span>
              <span className="text-xs text-cafe-muted shrink-0">{formatTime(assistantPresentationTime)}</span>
            </>
          )}
          <CopyIdButton messageId={message.id} />
          {message.extra?.recovery?.kind === 'f254_withheld_message' && (
            <span
              className="shrink-0 rounded-full border border-conn-blue-ring bg-conn-blue-bg px-1.5 py-0.5 text-micro font-semibold text-[var(--semantic-info)]"
              title="事故恢复：此消息曾被 F254 错误收起，现已按原作者、原时间和原文恢复"
            >
              事故恢复
            </span>
          )}
          {subexecutionEvents.length > 0 && (
            <span
              data-agent-role="root"
              className="shrink-0 rounded-full border border-conn-purple-ring bg-conn-purple-bg px-1.5 py-0.5 text-micro font-semibold text-conn-purple-text"
              title="这条普通回复由主 agent 持有；下方子 agent 记录保留各自身份"
            >
              主 agent
            </span>
          )}
          {isWhisper && (
            <span
              className={`text-xs px-1.5 py-0.5 rounded ${isRevealed ? 'bg-cafe-surface-elevated text-cafe-secondary' : 'bg-semantic-warning-surface text-semantic-warning'}`}
            >
              {isRevealed
                ? '已揭秘'
                : `悄悄话 → ${
                    message.whisperTo
                      ?.map((id) => {
                        const cat = getCatById(id);
                        return cat ? cat.displayName : id;
                      })
                      .join(', ') ?? ''
                  }`}
            </span>
          )}
          {!isWhisper && !message.extra?.targetCats?.length && direction && (
            <DirectionPill direction={direction} getCatById={getCatById} />
          )}
          {message.replyTo && resolvedReplyPreview && !isSchedulerReply && (
            <ReplyPill replyPreview={resolvedReplyPreview} replyToId={message.replyTo} getCatById={getCatById} />
          )}
          <InvocationTrajectoryAnchor message={message} threadId={renderThreadId} />
          <MessageActionSlot />
        </div>
        {companionIdentity && companionAuthorName && (
          <CompanionMessageIdentity identity={companionIdentity} authorName={companionAuthorName} />
        )}
        {showSchedulerAccent && (
          <div className={SCHEDULER_ACCENT_BADGE_CLASS}>
            <span aria-hidden>⏰</span>
            <span>定时提醒</span>
          </div>
        )}
        {crossThreadSourceThreadId &&
          (() => {
            const sourceId = crossThreadSourceThreadId;
            const sourceName = crossThreadSourceName ?? '未命名对话';
            const shortId = sourceId.replace(/^thread_/, '').slice(0, 8);
            const senderLabel = catStyle?.label;
            return (
              <a
                href={`/thread/${sourceId}`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const sourceInvocationId = message.extra?.crossPost?.sourceInvocationId;
                  if (sourceInvocationId) {
                    setPendingCrossPostScroll({
                      threadId: sourceId,
                      sourceInvocationId,
                      senderCatId: message.catId,
                    });
                  }
                  pushThreadRouteWithHistory(sourceId, typeof window !== 'undefined' ? window : undefined);
                }}
                className="inline-flex items-center gap-1.5 border px-3 py-1 rounded-full bg-cafe-surface border-cafe text-cafe hover:bg-cafe-surface-sunken transition-colors cursor-pointer w-fit max-w-full"
                title={sourceId}
                aria-label={`跳转到来源 thread ${sourceId}`}
              >
                <span className="text-micro font-semibold" aria-hidden>
                  📮
                </span>
                <span className="min-w-0 truncate">
                  {senderLabel && <span className="font-medium">{senderLabel} · </span>}
                  {shortId} · {sourceName}
                </span>
              </a>
            );
          })()}
      </div>
    ) : undefined;

  return (
    <MessageBubble
      messageId={message.id}
      presentation={showsNameplate ? 'nameplate' : 'bubble'}
      avatar={
        companionIdentity ? (
          <CompanionMessageAvatar identity={companionIdentity} />
        ) : catData ? (
          <CatAvatar
            catId={catData.id}
            size={32}
            status={
              message.lifecycle?.kind === 'response' && message.lifecycle.status === 'processing'
                ? 'streaming'
                : undefined
            }
            onClick={onEditCat ? () => onEditCat(catData.id) : undefined}
          />
        ) : null
      }
      header={catHeader}
      maxWidth={compact ? 'max-w-[86%]' : undefined}
      /* F056: always add cat-persona-derived so nested ThinkingContent/CliOutputBlock
       * have valid --cat-msg-{inset,inset-text,...} tokens even when catData is
       * undefined (e.g. stream messages without resolved catId). */
      wrapperClassName="group cat-persona-derived"
      wrapperStyle={
        catStyle ? ({ '--msg-hue': catStyle.msgHue, '--msg-chroma': catStyle.msgChroma } as CSSProperties) : undefined
      }
      bubbleRadius={catStyle ? catStyle.radius : 'rounded-2xl'}
      bubbleClassName={
        compact
          ? `w-fit max-w-full border border-[var(--conn-emerald-bubble-border)] ${catStyle?.font ?? ''}`
          : showsNameplate
            ? /* No breed voice: DESIGN.md keeps mono for machine output, and the reply is plain working text.
               * `pl-2` is the only inset: it lines the text (and the cards under it) up with the plate's avatar. */
              'pl-2'
            : catStyle
              ? `${catStyle.font ?? ''} ${emptyResponseNotice ? 'w-fit' : ''}`.trim()
              : `bg-cafe-surface ${emptyResponseNotice ? 'w-fit' : ''}`.trim()
      }
      bubbleStyle={
        compact
          ? {
              backgroundColor: 'color-mix(in oklch, var(--cafe-surface-elevated) 48%, var(--conn-emerald-bubble-bg))',
              color: 'var(--cafe-text)',
            }
          : showsNameplate
            ? { color: 'var(--cat-msg-text)' }
            : catStyle
              ? { backgroundColor: catStyle.bgColor, color: 'var(--cat-msg-text)' }
              : { color: 'var(--cat-msg-text)' }
      }
      footer={
        <>
          {!message.isStreaming && message.metadata ? <MetadataBadge metadata={message.metadata} /> : null}
          <AppendedInputReceipts response={message} timelineMessages={threadMessages} getCatById={getCatById} />
        </>
      }
    >
      {emptyResponseNotice && emptyResponseNotice.tone !== 'processing' ? (
        <CollapsibleMarkdown
          content={emptyResponseNotice.label}
          className={catStyle?.font}
          disclosureKey={bodyDisclosureKey}
        />
      ) : hasCliBlock && isStreamOrigin ? null : !isStreamOrigin && hasBlocks ? (
        <ContentBlocks blocks={message.contentBlocks!} publication={publication} />
      ) : !isStreamOrigin && hasTextContent ? (
        <CollapsibleMarkdown
          content={mergedSpeechContent ?? message.content}
          className={showsNameplate ? undefined : catStyle?.font}
          disclosureKey={bodyDisclosureKey}
        />
      ) : null}
      {implicitStructuredTargets.length > 0 ? (
        <div
          data-testid="implicit-structured-targets"
          className="mt-3 border-t border-current/10 pt-2 text-sm opacity-75"
        >
          {implicitStructuredTargets.map((catId) => {
            const cat = getCatById(catId);
            return (
              <div key={catId} data-target-cat-id={catId}>
                → @{cat ? formatCatName(cat) : '该成员'}
              </div>
            );
          })}
        </div>
      ) : null}
      {message.thinking && (
        <ThinkingContent
          content={message.thinking}
          className={showsNameplate ? undefined : catStyle?.font}
          label="Thinking"
          defaultExpanded={
            bubbleRestorePending
              ? false
              : resolveBubbleExpanded(currentThreadBubbleThinking, globalBubbleDefaults.thinking)
          }
          expandInExport={false}
          breedColor={catData?.color.primary}
          disclosureKey={thinkingDisclosureKey}
        />
      )}
      {hasCliBlock && (
        <CliOutputBlock
          events={cliEvents}
          status={cliStatus}
          thinkingMode={currentThreadThinkingMode}
          defaultExpanded={
            bubbleRestorePending ? false : resolveBubbleExpanded(currentThreadBubbleCli, globalBubbleDefaults.cliOutput)
          }
          breedColor={catData?.color.primary}
          disclosureKey={cliDisclosureKey}
        />
      )}
      {message.extra?.rich?.blocks && message.extra.rich.blocks.length > 0 && (
        <RichBlocks
          blocks={message.extra.rich.blocks}
          publication={publication}
          catId={message.catId}
          messageId={message.id}
          sourceThreadId={renderThreadId}
          sourceMessageIds={message.projectionSourceMessageIds ?? [message.id]}
          messageSource={message.source}
          htmlWidgetDisclosureKeys={richHtmlDisclosureKeys}
          forwardingEnabled={!message.isStreaming && !forwardingDisabled}
          sendContext={sendContext}
          confirmations={confirmations}
        />
      )}
      <SubexecutionActivity events={subexecutionEvents} />
      {showPawFeelDisposition ? <PawFeelDispositionDock messageId={message.id} /> : null}
      {message.isStreaming && !isStreamOrigin && (
        <span className="inline-block w-1.5 h-4 bg-current animate-pulse ml-0.5 rounded-full opacity-50" />
      )}
    </MessageBubble>
  );
}

export const ChatMessage = memo(function ChatMessage(props: ChatMessageProps) {
  const lifecycleTimeline = useChatStore(
    (state) =>
      props.timelineMessages ??
      (props.message.lifecycle?.dispatchRefs?.length
        ? getOrderedMessageTimeline(state.messages)
        : EMPTY_TIMELINE_MESSAGES),
  );
  if (isHiddenChatRow(props.message)) return null;
  return (
    <>
      <ChatMessageContent {...props} />
      <MessageDispatchAvatars
        message={props.message}
        timelineMessages={lifecycleTimeline}
        activeRuns={props.activeRuns ?? []}
        getCatLabel={(catId) => {
          const cat = props.getCatById(catId);
          return cat ? formatCatName(cat) : catId;
        }}
      />
    </>
  );
});
