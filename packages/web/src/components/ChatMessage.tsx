'use client';

import { companionIdentitySnapshotV1Schema, isCrossThreadProvenance } from '@cat-cafe/shared';
import { type CSSProperties, memo, type ReactNode, useState } from 'react';
import { formatSessionSealRequested, formatVisibleSystemInfo } from '@/hooks/system-info-visible';
import { type CatData, formatCatName } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { useTts } from '@/hooks/useTts';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { catColorVar, catSlug } from '@/lib/cat-slug';
import { CO_CREATOR_COLOR } from '@/lib/color-defaults';
import { hexToOklch } from '@/lib/color-utils';
import { getMentionRe, getMentionToCat } from '@/lib/mention-highlight';
import { parseDirection } from '@/lib/parse-direction';
import { CLASSIC_NAME_OPACITY } from '@/lib/readable-name-role';
import { type ChatMessage as ChatMessageType, resolveBubbleExpanded, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { setPendingCrossPostScroll } from '@/utils/crosspost-scroll-target';
import { doesAssistantMessageRenderBubble } from './assistant-message-renderability';
import { CatAvatar } from './CatAvatar';
import { CatNameplate } from './CatNameplate';
import { CliDiagnosticsPanel, isKnownReason } from './CliDiagnosticsPanel';
import { CloudBindingRecoveryCard } from './CloudBindingRecoveryCard';
import { CollapsibleMarkdown } from './CollapsibleMarkdown';
import { ConnectorBubble } from './ConnectorBubble';
import { ContentBlocks } from './ContentBlocks';
import { CopyIdButton } from './CopyIdButton';
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
import { focusTurnAbsorptionSummary, MessageReceiptDock } from './MessageReceiptDock';
import { MetadataBadge } from './MetadataBadge';
import { buildMessageDisclosureKey, buildRichHtmlDisclosureKey } from './message-disclosure-state';
import { isConnectorSystemNotice, projectedExecutionIds } from './message-render-visibility';
import { isLastOfOwnRun } from './own-message-run';
import { PawFeelDispositionDock } from './paw-feel/PawFeelDispositionDock';
import { ReplyPill } from './ReplyPill';
import { BriefingCard } from './rich/BriefingCard';
import type { CardConfirmationEntry } from './rich/CardBlock';
import { CustodyOfferCard } from './rich/CustodyOfferCard';
import { RichBlocks } from './rich/RichBlocks';
import { RoutingPreflightActions } from './routing-context/RoutingPreflightActions';
import { SubexecutionActivity } from './SubexecutionActivity';
import { SummaryCard } from './SummaryCard';
import { SystemNoticeBar } from './SystemNoticeBar';
import { useShellPresentation } from './shell/shell-presentation';
import { ThinkingContent } from './ThinkingContent';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { TimeoutDiagnosticsPanel } from './TimeoutDiagnosticsPanel';
import { TtsPlayButton } from './TtsPlayButton';
import { TurnAbsorptionDock } from './TurnAbsorptionDock';
import {
  foldedSourceInvocationIdInTimeline,
  projectTurnAbsorptionSummary,
  terminalSurfaceMessageId,
} from './turn-absorption-summary';

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

function getFreshnessNotice(message: ChatMessageType): { text: string; title?: string } | null {
  const projection = message.extra?.freshnessSupplement;
  const annotation = message.extra?.freshness;
  if (projection) {
    let text: string;
    switch (projection.status) {
      case 'pending':
        text = `生成期间有 ${projection.requiredCount} 条新消息，等待补充检查`;
        break;
      case 'running':
        text = `正在核对生成期间的 ${projection.requiredCount} 条新消息…`;
        break;
      case 'committed':
        text = '已核对，并在下方追加了补充';
        break;
      case 'declined':
        text = '已核对，无需补充';
        break;
      case 'failed':
        text = '补充检查未完成';
        break;
    }
    if (projection.budgetExhaustedCount) {
      text += `；另有 ${projection.budgetExhaustedCount} 条更新超出自动检查上限`;
    }
    return {
      text,
      ...(projection.terminalReason ? { title: `状态原因：${projection.terminalReason}` } : {}),
    };
  }
  if (annotation?.kind === 'published_with_unseen') {
    const fact = `此回复生成期间有 ${annotation.generatedWithUnseen.length} 条新消息`;
    return annotation.supplementFailureReason
      ? { text: `${fact}；补充检查未能安排`, title: '状态原因：基础设施暂不可用' }
      : { text: fact };
  }
  if (annotation?.kind === 'freshness_unknown') {
    return { text: '未能确认此回复生成期间的消息边界', title: `状态原因：${annotation.reason}` };
  }
  if (annotation?.kind === 'scan_pending') return { text: '正在核对生成期间的消息边界…' };
  return null;
}

interface ChatMessageProps {
  message: ChatMessageType;
  compact?: boolean;
  threadId?: string;
  timelineMessages?: readonly ChatMessageType[];
  activeInvocationIds?: ReadonlySet<string>;
  settlingInvocationIds?: ReadonlySet<string>;
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
  /** Routes interactive rich-block sends to the surface that owns this message row. */
  sendContext?: string;
  confirmations?: CardConfirmationEntry[];
}

function needsTimelineProjection(message: ChatMessageType): boolean {
  return Boolean(
    message.extra?.queueReceipt ||
      hasCloudBindingRecoveryMetadata(message) ||
      message.extra?.turnExecution ||
      message.extra?.auxiliaryTurnExecutions?.length ||
      (message.source?.connector === 'hold-ball' && typeof message.source.meta?.taskId === 'string') ||
      isSchedulerReplyPreview(message.replyPreview),
  );
}

export const ChatMessage = memo(function ChatMessage({
  message,
  compact = false,
  threadId,
  timelineMessages,
  activeInvocationIds,
  settlingInvocationIds,
  getCatById,
  onEditCat,
  onEditCoCreator,
  hideDiagnosticsPanel,
  dedupCount,
  forwardingDisabled = false,
  sendContext,
  confirmations,
}: ChatMessageProps) {
  // The Café 1.6 cat reply (nameplate, no outer bubble) is a presentation of the same message, switched by the one shell
  // switch. Read it with the other hooks, before any early return.
  const shellPresentation = useShellPresentation();
  const coCreator = useCoCreatorConfig();
  const { state: ttsState, synthesize: ttsSynthesize, activeMessageId } = useTts();
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
    (s) => timelineMessages ?? (needsTimelineProjection(message) ? s.messages : EMPTY_TIMELINE_MESSAGES),
  );
  const globalBubbleDefaults = useChatStore((s) => s.globalBubbleDefaults);
  const candidateSourceThreadId = message.extra?.crossPost?.sourceThreadId;
  const crossThreadSourceThreadId = isCrossThreadProvenance(candidateSourceThreadId, renderThreadId)
    ? candidateSourceThreadId
    : undefined;
  const [retryingClosureId, setRetryingClosureId] = useState<string | null>(null);
  const isUser = message.type === 'user' && !message.catId;
  const isSystem = message.type === 'system';
  const isSummary = message.type === 'summary';
  const isConnector = message.type === 'connector';
  const cloudBindingRecovery = isUser ? projectCloudBindingRecovery(message, threadMessages) : undefined;
  const projectedSystemContent = message.extra?.systemInfo
    ? ((
        formatVisibleSystemInfo(
          message.extra.systemInfo.payload,
          (catId) => resolveCatDisplayName(catId, getCatById),
          message.extra.systemInfo.fallbackCatId,
        ) ??
        formatSessionSealRequested(message.extra.systemInfo.payload, (catId) =>
          resolveCatDisplayName(catId, getCatById),
        )
      )?.content ?? message.content)
    : message.content;

  const catData = message.catId ? getCatById(message.catId) : undefined;
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
        const label = formatCatName(catData);
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
  const isSchedulerReply = isSchedulerReplyPreview(message.replyPreview);
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
  const freshnessNotice = getFreshnessNotice(message);
  const subexecutionEvents = message.metadata?.subexecutionEvents ?? [];
  // Fetch optimization only: the API reuses the canonical parser and decides
  // whether this exact message owns a signal. Never use this sentinel as intake.
  const showPawFeelDisposition =
    !message.isStreaming && Boolean(message.catId) && message.content.includes('[爪感差') && !crossThreadSourceThreadId;
  const turnAbsorptionProjections = message.isStreaming
    ? []
    : projectedExecutionIds(message)
        .filter((invocationId) => terminalSurfaceMessageId(threadMessages, invocationId) === message.id)
        .map((invocationId) => projectTurnAbsorptionSummary(threadMessages, invocationId))
        .filter((projection) => projection !== null);
  const terminalTrajectory = describeMessageInvocationTrajectory(message);
  const showTerminalTrajectoryAnchor = terminalTrajectory && terminalTrajectory.status !== 'done';
  const renderTurnAbsorptionDocks = () =>
    turnAbsorptionProjections.map((projection) => (
      <TurnAbsorptionDock
        key={projection.invocationId}
        projection={projection}
        messages={threadMessages}
        sourceAuthorLabel={coCreator.name}
        getCatLabel={(catId) => {
          const cat = getCatById(catId);
          return cat ? formatCatName(cat) : catId;
        }}
      />
    ));
  const renderCenteredTerminalSystemSurface = (content: ReactNode) => (
    <div data-message-id={message.id} className="group flex justify-center mb-3">
      <div className="max-w-[85%] w-full">
        {showTerminalTrajectoryAnchor && (
          <div className="mb-1 flex justify-center">
            <InvocationTrajectoryAnchor message={message} threadId={renderThreadId} />
          </div>
        )}
        {content}
        {renderTurnAbsorptionDocks()}
      </div>
    </div>
  );

  const direction = catData
    ? parseDirection(message, () => ({ toCat: getMentionToCat(), re: getMentionRe() }), currentThreadId)
    : null;

  // ADR-042 supplement speech is an ordinary additive reply. It may retain the
  // provider's stream provenance, but that provenance must not turn its body
  // into an internal CLI Output card.
  const isStreamOrigin = message.origin === 'stream' && !message.extra?.supplement;
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
    // F148 ContextBriefing and F233 duty briefing are user-visible, collapsed cards.
    // F148 remains distinguishable via extra.systemKind='context_briefing'.
    if (message.origin === 'briefing' && message.extra?.rich?.blocks?.length) {
      return (
        <div data-message-id={message.id} className="flex justify-center mb-3">
          <div className="max-w-[85%] w-full opacity-80">
            <BriefingCard block={message.extra.rich.blocks[0]} messageId={message.id} />
          </div>
        </div>
      );
    }

    if (message.variant === 'evidence' && message.evidence) {
      return <EvidencePanel data={message.evidence} />;
    }

    if (message.variant === 'governance_blocked' && message.extra?.governanceBlocked) {
      const { projectPath, reasonKind, invocationId } = message.extra.governanceBlocked;
      return <GovernanceBlockedCard projectPath={projectPath} reasonKind={reasonKind} invocationId={invocationId} />;
    }

    // F045: variant='thinking' is deprecated — thinking is now embedded in assistant bubbles.

    const isLegacyError = !message.variant && message.content.trim().startsWith('Error:');
    const isError = message.variant === 'error' || isLegacyError;
    const canRenderCliDiagnostics = isError || (message.type === 'system' && Boolean(message.extra?.cliDiagnostics));
    const isTool = message.variant === 'tool';
    const isFollowup = message.variant === 'a2a_followup';
    const freshnessClosure = message.extra?.freshnessClosure;
    const freshnessClosureRecordedAt =
      typeof freshnessClosure?.updatedAt === 'number' && Number.isFinite(freshnessClosure.updatedAt)
        ? freshnessClosure.updatedAt
        : undefined;
    const isLegacyFreshnessClosure = freshnessClosure?.legacy === true;

    // F212 Phase B routing precedence (砚砚 P1-1 + 云端 codex P2-3, 2026-05-27):
    //   1. Classified CLI error (reasonCode in REASON_PALETTE) → CLI panel
    //   2. Timeout with no recognized classification → timeout panel
    //      (preserves F118 silence/processAlive; covers unknown-reason persisted payloads too)
    //   3. Unclassified CLI error, no timeout → CLI panel unknown-icon fallback
    // The `isKnownReason` membership check (not truthy) is the key defense against
    // persisted/newer/malformed reasonCode strings hijacking the timeout view.
    if (canRenderCliDiagnostics && isKnownReason(message.extra?.cliDiagnostics?.reasonCode)) {
      // F212 follow-up — UI-layer dedup: if this is a subsequent duplicate of an adjacent
      // dedup group, hide the panel (group head already rendered it with a ×N badge). We
      // still render an empty wrapping div with data-message-id so MessageNavigator dots,
      // ReplyPill jumps, and scrollToMessage queries continue to resolve the anchor —
      // dropping the wrapper would silently break navigation/audit trail for the hidden
      // duplicates (codex review PR #1967 P2 catch). h-0 keeps the anchor at zero visual
      // cost; the group head's panel right above carries all the info via ×N badge.
      if (hideDiagnosticsPanel && turnAbsorptionProjections.length === 0) {
        return <div data-message-id={message.id} aria-hidden="true" className="h-0" />;
      }
      return renderCenteredTerminalSystemSurface(
        hideDiagnosticsPanel ? null : (
          <CliDiagnosticsPanel
            errorMessage={message.content}
            diagnostics={message.extra.cliDiagnostics}
            dedupCount={dedupCount}
          />
        ),
      );
    }

    // F118 AC-C3: Enhanced timeout diagnostics panel (precedence step 2)
    if (isError && message.extra?.timeoutDiagnostics) {
      return renderCenteredTerminalSystemSurface(
        <TimeoutDiagnosticsPanel errorMessage={message.content} diagnostics={message.extra.timeoutDiagnostics} />,
      );
    }

    // F212 Phase B precedence step 3: unclassified cliDiagnostics with no timeout.
    if (canRenderCliDiagnostics && message.extra?.cliDiagnostics) {
      // F212 follow-up — UI-layer dedup (mirrors the classified-path branch above):
      // preserve data-message-id anchor so navigation/scroll targets resolve.
      if (hideDiagnosticsPanel && turnAbsorptionProjections.length === 0) {
        return <div data-message-id={message.id} aria-hidden="true" className="h-0" />;
      }
      return renderCenteredTerminalSystemSurface(
        hideDiagnosticsPanel ? null : (
          <CliDiagnosticsPanel
            errorMessage={message.content}
            diagnostics={message.extra.cliDiagnostics}
            dedupCount={dedupCount}
          />
        ),
      );
    }

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
            {message.extra?.systemInfo?.payload.type === 'routing_preflight' && (
              <RoutingPreflightActions payload={message.extra.systemInfo.payload} />
            )}
            {freshnessClosureRecordedAt !== undefined && (
              <span className="ml-2 text-xs opacity-75">
                {isLegacyFreshnessClosure ? '历史责任 · ' : '记录于 '}
                <time data-freshness-closure-recorded-at dateTime={new Date(freshnessClosureRecordedAt).toISOString()}>
                  {formatTime(freshnessClosureRecordedAt)}
                </time>
                {isLegacyFreshnessClosure ? ' · 等待迁移核销' : ''}
              </span>
            )}
            {freshnessClosure?.status === 'blocked' && currentThreadId && !isLegacyFreshnessClosure && (
              <button
                type="button"
                disabled={retryingClosureId === freshnessClosure.closureId}
                className="ml-3 rounded-md border border-default px-2 py-1 text-xs font-semibold text-primary disabled:opacity-50"
                onClick={() => {
                  setRetryingClosureId(freshnessClosure.closureId);
                  void apiFetch(
                    `/api/threads/${currentThreadId}/freshness-closures/${freshnessClosure.closureId}/retry`,
                    { method: 'POST' },
                  ).finally(() => setRetryingClosureId(null));
                }}
              >
                {retryingClosureId === freshnessClosure.closureId ? '重试中…' : '重试'}
              </button>
            )}
            {isFollowup && (
              <span className="block mt-1 text-xs text-[var(--color-cocreator-primary)]">
                输入 @猫名 跟进 来发起 follow-up
              </span>
            )}
            {renderTurnAbsorptionDocks()}
          </div>
        </div>
      </div>
    );
  }

  if (isConnector && message.source) {
    if (isConnectorSystemNotice(message)) {
      if (isLinkedCloudBindingRecoveryNotice(message, threadMessages)) return null;
      return <SystemNoticeBar message={message} />;
    }
    return <ConnectorBubble message={message} threadId={currentThreadId} timelineMessages={threadMessages} />;
  }

  // Zero-exposure recall is an invisible storage tombstone. History filtering
  // is authoritative; this guard keeps stale client caches from flashing it.
  if (isUser && message.extra?.recall?.exposure === 'none') return null;

  const messageReceiptDock = message.extra?.queueReceipt ? (
    <MessageReceiptDock
      messageId={message.id}
      receipt={message.extra.queueReceipt}
      messages={threadMessages}
      activeInvocationIds={activeInvocationIds}
      settlingInvocationIds={settlingInvocationIds}
      getCatLabel={(catId) => {
        const cat = getCatById(catId);
        return cat ? formatCatName(cat) : catId;
      }}
    />
  ) : null;

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
    const humanHasMarks = isWhisper || Boolean(message.replyTo && message.replyPreview && !isSchedulerReply);
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
        {message.replyTo && message.replyPreview && !isSchedulerReply && (
          <ReplyPill replyPreview={message.replyPreview} replyToId={message.replyTo} getCatById={getCatById} />
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
        {message.replyTo && message.replyPreview && !isSchedulerReply && (
          <ReplyPill replyPreview={message.replyPreview} replyToId={message.replyTo} getCatById={getCatById} />
        )}
        <span className="text-xs text-cafe-muted">{formatDualTime(message.timestamp, message.deliveredAt)}</span>
        <CopyIdButton messageId={message.id} />
        <span className="text-xs font-semibold" style={{ color: 'var(--color-cocreator-primary)' }}>
          {coCreator.name}
        </span>
      </div>
    );

    const whisperActive = isWhisper && !isRevealed;
    const foldedInvocationId = foldedSourceInvocationIdInTimeline(message, threadMessages);
    const bodyIsFolded = foldedInvocationId !== undefined;
    const recalledAfterExposure = message.extra?.recall?.exposure === 'seen';

    if (bodyIsFolded && foldedInvocationId) {
      return (
        <div
          data-message-id={message.id}
          data-folded-source-anchor={foldedInvocationId}
          aria-hidden="true"
          className="h-0 overflow-hidden"
        >
          <button
            hidden
            type="button"
            data-folded-source-affordance
            data-folded-source-return={foldedInvocationId}
            className="ml-auto block rounded-md border border-cafe bg-cafe-surface px-2 py-1 text-xs font-medium text-cafe-muted hover:text-cafe-secondary"
            onClick={() => focusTurnAbsorptionSummary(threadMessages, foldedInvocationId)}
          >
            该补充已归入上方回复 · 返回本轮摘要 ↑
          </button>
        </div>
      );
    }

    return (
      <MessageBubble
        messageId={message.id}
        align="right"
        presentation={humanPresentation ? 'human' : 'bubble'}
        maxWidth={compact ? 'max-w-[86%]' : undefined}
        avatar={userAvatar}
        header={userHeader}
        footer={humanTime}
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
        {messageReceiptDock}
      </MessageBubble>
    );
  }

  // Keep the real bubble and pending placeholder on the same visual predicate.
  // Identity/lifecycle metadata alone must not tear down the placeholder before
  // an assistant avatar and frame can actually take over.
  if (
    !doesAssistantMessageRenderBubble(message, {
      currentThreadId: renderThreadId,
      hasCliBlock,
      hasCrossThreadSource: Boolean(crossThreadSourceThreadId),
    })
  ) {
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
    message.extra?.supplement ||
    message.extra?.turnExecution ||
    message.extra?.auxiliaryTurnExecutions?.length ||
    subexecutionEvents.length ? (
      <div
        className="mb-1 flex flex-col gap-1 min-w-0"
        data-testid="message-header"
        data-turn-execution-owner={message.extra?.turnExecution?.invocationId}
      >
        <div className="flex items-center gap-2 min-w-0">
          {showsNameplate && message.catId && catStyle ? (
            <>
              <CatNameplate
                catId={message.catId}
                name={catStyle.label}
                streaming={message.isStreaming}
                onEditCat={onEditCat ? () => onEditCat(message.catId!) : undefined}
              />
              <span
                data-testid="cat-nameplate-time"
                className="text-xs shrink-0"
                style={{ color: 'var(--shell-muted)' }}
              >
                {formatTime(message.timestamp)}
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
                    : (catStyle?.label ?? message.catId)
                }
              >
                {companionIdentity
                  ? `猫猫球 · ${companionIdentity.partner.displayName}`
                  : (catStyle?.label ?? message.catId)}
              </span>
              <span className="text-xs text-cafe-muted shrink-0">{formatTime(message.timestamp)}</span>
            </>
          )}
          <CopyIdButton messageId={message.id} />
          <InvocationTrajectoryAnchor message={message} threadId={renderThreadId} />
          {message.extra?.recovery?.kind === 'f254_withheld_message' && (
            <span
              className="shrink-0 rounded-full border border-conn-blue-ring bg-conn-blue-bg px-1.5 py-0.5 text-micro font-semibold text-[var(--semantic-info)]"
              title="事故恢复：此消息曾被 F254 错误收起，现已按原作者、原时间和原文恢复"
            >
              事故恢复
            </span>
          )}
          {message.extra?.turnExecution?.executionKind === 'routing_guard' && (
            <span
              className="shrink-0 rounded-full border border-conn-amber-ring bg-conn-amber-bg px-1.5 py-0.5 text-micro font-semibold text-conn-amber-text"
              title={`系统因上一轮缺少合法路由出口而执行了一次补路由；child ${message.extra.turnExecution.invocationId}`}
              data-turn-execution-kind="routing_guard"
            >
              系统补路由
            </span>
          )}
          {message.extra?.turnExecution?.executionKind === 'freshness_supplement' && (
            <span
              className="shrink-0 rounded-full border border-conn-blue-ring bg-conn-blue-bg px-1.5 py-0.5 text-micro font-semibold text-[var(--semantic-info)]"
              title={`针对真正相关的后到消息执行补充；child ${message.extra.turnExecution.invocationId}`}
              data-turn-execution-kind="freshness_supplement"
            >
              后到消息补充{message.extra.supplement ? ` ${message.extra.supplement.seq}` : ''}
            </span>
          )}
          {message.extra?.auxiliaryTurnExecutions?.map((execution) => {
            const label =
              execution.executionKind === 'routing_guard'
                ? '系统补路由'
                : execution.executionKind === 'freshness_supplement'
                  ? '后到消息补充'
                  : '普通执行（无正文）';
            const title =
              execution.executionKind === 'routing_guard'
                ? `系统为这条普通回复补了一次路由出口；child ${execution.invocationId}`
                : execution.executionKind === 'freshness_supplement'
                  ? `针对真正相关的后到消息执行补充；child ${execution.invocationId}`
                  : `本轮普通执行未产生独立正文；child ${execution.invocationId}`;
            return (
              <span
                key={execution.invocationId}
                className={
                  execution.executionKind === 'routing_guard'
                    ? 'shrink-0 rounded-full border border-conn-amber-ring bg-conn-amber-bg px-1.5 py-0.5 text-micro font-semibold text-conn-amber-text'
                    : 'shrink-0 rounded-full border border-conn-blue-ring bg-conn-blue-bg px-1.5 py-0.5 text-micro font-semibold text-[var(--semantic-info)]'
                }
                title={title}
                data-auxiliary-turn-execution={execution.invocationId}
                data-turn-execution-kind={execution.executionKind}
              >
                {label}
              </span>
            );
          })}
          {message.extra?.supplement && message.extra?.turnExecution?.executionKind !== 'freshness_supplement' && (
            <span
              className="shrink-0 rounded-full border border-conn-blue-ring bg-conn-blue-bg px-1.5 py-0.5 text-micro font-semibold text-[var(--semantic-info)]"
              title="这条消息补充上方关联的原回复"
            >
              对上条回复的补充
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
          {!isWhisper && direction && <DirectionPill direction={direction} getCatById={getCatById} />}
          {message.replyTo && message.replyPreview && !isSchedulerReply && (
            <ReplyPill replyPreview={message.replyPreview} replyToId={message.replyTo} getCatById={getCatById} />
          )}
          {hasTextContent && !message.isStreaming && (
            <TtsPlayButton
              messageId={message.id}
              text={message.content}
              catId={message.catId!}
              ttsState={ttsState}
              activeMessageId={activeMessageId}
              onSynthesize={ttsSynthesize}
            />
          )}
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
            catId={message.catId!}
            size={32}
            status={message.isStreaming ? 'streaming' : undefined}
            onClick={onEditCat && message.catId ? () => onEditCat(message.catId!) : undefined}
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
              ? (catStyle.font ?? '')
              : 'bg-cafe-surface'
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
      footer={!message.isStreaming && message.metadata ? <MetadataBadge metadata={message.metadata} /> : undefined}
    >
      {hasCliBlock && isStreamOrigin ? null : !isStreamOrigin && hasBlocks ? (
        <ContentBlocks blocks={message.contentBlocks!} publication={publication} />
      ) : !isStreamOrigin && hasTextContent ? (
        <CollapsibleMarkdown
          content={mergedSpeechContent ?? message.content}
          className={showsNameplate ? undefined : catStyle?.font}
          disclosureKey={bodyDisclosureKey}
        />
      ) : message.isStreaming ? (
        <span className="text-xs text-cafe-secondary">Thinking...</span>
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
      {freshnessNotice && !message.extra?.supplement && (
        <div
          data-testid="freshness-supplement-status"
          role="status"
          title={freshnessNotice.title}
          className="mt-2 rounded-md border border-conn-blue-ring/60 bg-conn-blue-bg/60 px-2 py-1 text-xs text-[var(--semantic-info)]"
        >
          {freshnessNotice.text}
        </div>
      )}
      {messageReceiptDock}
      {renderTurnAbsorptionDocks()}
      {showPawFeelDisposition ? <PawFeelDispositionDock messageId={message.id} /> : null}
      {message.isStreaming && !isStreamOrigin && (
        <span className="inline-block w-1.5 h-4 bg-current animate-pulse ml-0.5 rounded-full opacity-50" />
      )}
    </MessageBubble>
  );
});
