'use client';

import type { CatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { useTts } from '@/hooks/useTts';
import { hexToRgba, tintedLight } from '@/lib/color-utils';
import { getMentionRe, getMentionToCat } from '@/lib/mention-highlight';
import { parseDirection } from '@/lib/parse-direction';
import { type ChatMessage as ChatMessageType, resolveBubbleExpanded, useChatStore } from '@/stores/chatStore';
import { CatAvatar } from './CatAvatar';
import { CollapsibleMarkdown } from './CollapsibleMarkdown';
import { ConnectorBubble } from './ConnectorBubble';
import { ContentBlocks } from './ContentBlocks';
import { CliOutputBlock } from './cli-output/CliOutputBlock';
import { toCliEvents } from './cli-output/toCliEvents';
import { DirectionPill } from './DirectionPill';
import { EvidencePanel } from './EvidencePanel';
import { GovernanceBlockedCard } from './GovernanceBlockedCard';
import { MetadataBadge } from './MetadataBadge';
import { ReplyPill } from './ReplyPill';
import { BriefingCard } from './rich/BriefingCard';
import { RichBlocks } from './rich/RichBlocks';
import { SummaryCard } from './SummaryCard';
import { SystemNoticeBar } from './SystemNoticeBar';
import { ThinkingContent } from './ThinkingContent';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { TimeoutDiagnosticsPanel } from './TimeoutDiagnosticsPanel';
import { TtsPlayButton } from './TtsPlayButton';

const BREED_STYLES: Record<string, { radius: string; font?: string }> = {
  ragdoll: { radius: 'rounded-2xl rounded-bl-sm' },
  'maine-coon': { radius: 'rounded-2xl rounded-br-sm', font: 'font-mono' },
  siamese: { radius: 'rounded-2xl rounded-tr-sm' },
  'dragon-li': { radius: 'rounded-lg rounded-tl-sm', font: 'font-mono' },
};
const DEFAULT_BREED_STYLE = { radius: 'rounded-2xl' };
const SCHEDULER_ACCENT_BADGE_CLASS =
  'inline-flex w-fit items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800 shadow-sm';
const SCHEDULER_ACCENT_BUBBLE_CLASS =
  'border-amber-300 bg-amber-50/70 ring-1 ring-amber-200 shadow-[0_10px_24px_rgba(217,119,6,0.16)] bg-gradient-to-b from-amber-50/60 to-transparent';

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

function isConnectorSystemNotice(message: ChatMessageType): boolean {
  if (message.type !== 'connector' || !message.source?.meta) return false;
  return (message.source.meta as Record<string, unknown>).presentation === 'system_notice';
}

interface ChatMessageProps {
  message: ChatMessageType;
  getCatById: (id: string) => CatData | undefined;
}

export function ChatMessage({ message, getCatById }: ChatMessageProps) {
  const coCreator = useCoCreatorConfig();
  const { state: ttsState, synthesize: ttsSynthesize, activeMessageId } = useTts();
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const isLoadingThreads = useChatStore((s) => s.isLoadingThreads);
  const threads = useChatStore((s) => s.threads);
  const threadMessages = useChatStore((s) => s.messages);
  const globalBubbleDefaults = useChatStore((s) => s.globalBubbleDefaults);
  const isUser = message.type === 'user' && !message.catId;
  const isSystem = message.type === 'system';
  const isSummary = message.type === 'summary';
  const isConnector = message.type === 'connector';

  const catData = message.catId ? getCatById(message.catId) : undefined;
  const catStyle = catData
    ? (() => {
        const breed = BREED_STYLES[catData.breedId ?? ''] ?? DEFAULT_BREED_STYLE;
        const idLabel = catData.id.charAt(0).toUpperCase() + catData.id.slice(1);
        const label = catData.variantLabel
          ? `${catData.displayName}（${catData.variantLabel}）`
          : `${catData.displayName}（${idLabel}）`;
        const isCallback = message.origin === 'callback';
        return {
          label,
          radius: breed.radius,
          font: breed.font,
          bgColor: isCallback ? tintedLight(catData.color.primary, 0.08) : catData.color.secondary,
          borderColor: isCallback ? hexToRgba(catData.color.primary, 0.12) : hexToRgba(catData.color.primary, 0.3),
        };
      })()
    : null;
  const currentThread = useChatStore((s) => s.threads.find((t) => t.id === s.currentThreadId));
  const bubbleRestorePending = isLoadingThreads && !!currentThreadId && !currentThread;
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

  const direction = catData ? parseDirection(message, () => ({ toCat: getMentionToCat(), re: getMentionRe() })) : null;

  const isStreamOrigin = message.origin === 'stream';
  const cliEvents = toCliEvents(message.toolEvents, isStreamOrigin ? message.content : undefined);
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
    // F148 Phase E + VG-2: Briefing card — collapsible with source label
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
    const isTool = message.variant === 'tool';
    const isFollowup = message.variant === 'a2a_followup';

    // F118 AC-C3: Enhanced timeout diagnostics panel
    if (isError && message.extra?.timeoutDiagnostics) {
      return (
        <div data-message-id={message.id} className="flex justify-center mb-3">
          <div className="max-w-[85%] w-full">
            <TimeoutDiagnosticsPanel errorMessage={message.content} diagnostics={message.extra.timeoutDiagnostics} />
          </div>
        </div>
      );
    }

    const toneClass = isTool
      ? 'text-cafe-muted bg-cafe-surface-elevated/50 font-mono text-xs py-1'
      : isFollowup
        ? 'text-purple-700 bg-purple-50 border border-purple-200'
        : isError
          ? 'text-red-500 bg-red-50 rounded-full'
          : 'text-blue-700 bg-blue-50';
    return (
      <div data-message-id={message.id} className={`flex justify-center ${isTool ? 'mb-1' : 'mb-3'}`}>
        <div className={`text-sm px-4 py-2 rounded-lg whitespace-pre-wrap text-left max-w-[85%] ${toneClass}`}>
          {isFollowup && <span className="mr-1">🔗</span>}
          {message.content}
          {isFollowup && <span className="block mt-1 text-xs text-purple-500">输入 @猫名 跟进 来发起 follow-up</span>}
        </div>
      </div>
    );
  }

  if (isConnector && message.source) {
    if (isConnectorSystemNotice(message)) {
      return <SystemNoticeBar message={message} />;
    }
    return <ConnectorBubble message={message} />;
  }

  if (isUser) {
    const coCreatorPrimary = coCreator.color?.primary ?? '#815b5b';
    const coCreatorSecondary = coCreator.color?.secondary ?? '#FFDDD2';
    return (
      <div data-message-id={message.id} className="flex justify-end gap-2 mb-4 items-start">
        <div className="max-w-[75%]">
          <div className="flex justify-end items-center gap-2 mb-1">
            {isWhisper && (
              <span
                className={`text-xs px-1.5 py-0.5 rounded ${isRevealed ? 'bg-cafe-surface-elevated text-cafe-secondary' : 'bg-amber-100 text-amber-600'}`}
              >
                {isRevealed ? '已揭秘' : `悄悄话 → ${message.whisperTo?.join(', ') ?? ''}`}
              </span>
            )}
            {message.replyTo && message.replyPreview && !isSchedulerReply && (
              <ReplyPill replyPreview={message.replyPreview} replyToId={message.replyTo} getCatById={getCatById} />
            )}
            <span className="text-xs text-cafe-muted">{formatDualTime(message.timestamp, message.deliveredAt)}</span>
            <span className="text-xs font-semibold" style={{ color: coCreatorPrimary }}>
              {coCreator.name}
            </span>
          </div>
          <div
            className={`rounded-2xl rounded-br-sm px-4 py-3 transition-transform hover:-translate-y-0.5 ${
              isWhisper && !isRevealed ? 'bg-amber-50 text-amber-900 border border-dashed border-amber-300' : ''
            }`}
            style={
              !isWhisper || isRevealed
                ? {
                    backgroundColor: coCreatorSecondary,
                    color: coCreatorPrimary,
                  }
                : undefined
            }
          >
            {hasBlocks ? (
              <ContentBlocks blocks={message.contentBlocks!} />
            ) : (
              <CollapsibleMarkdown content={message.content} />
            )}
          </div>
        </div>
        <div
          className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 ring-2 flex items-center justify-center text-[11px] font-bold text-white"
          style={{ backgroundColor: coCreatorPrimary, boxShadow: `0 0 0 2px ${coCreatorSecondary}` }}
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
        </div>
      </div>
    );
  }

  // Don't render completely empty non-streaming assistant messages.
  // This can happen when a cat responds with only internal tool use and no text output.
  // Keep messages that have thinking content — they should still show as collapsible bubbles.
  if (
    !message.isStreaming &&
    !hasTextContent &&
    !hasCliBlock &&
    !hasBlocks &&
    !message.extra?.rich?.blocks?.length &&
    !message.extra?.crossPost &&
    !message.thinking
  ) {
    return null;
  }

  return (
    <div data-message-id={message.id} className="group flex gap-2 mb-4 items-start">
      {catData && <CatAvatar catId={message.catId!} size={32} status={message.isStreaming ? 'streaming' : undefined} />}
      <div className="max-w-[85%] md:max-w-[75%] min-w-0">
        {catStyle && (
          <div className="mb-1 flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-semibold" style={{ opacity: 0.8 }}>
                {catStyle.label}
              </span>
              <span className="text-xs text-cafe-muted">{formatTime(message.timestamp)}</span>
              {isWhisper && (
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${isRevealed ? 'bg-cafe-surface-elevated text-cafe-secondary' : 'bg-amber-100 text-amber-600'}`}
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
            </div>
            {showSchedulerAccent && (
              <div className={SCHEDULER_ACCENT_BADGE_CLASS}>
                <span aria-hidden>⏰</span>
                <span>定时提醒</span>
              </div>
            )}
            {message.extra?.crossPost &&
              (() => {
                const sourceId = message.extra.crossPost?.sourceThreadId;
                const sourceName = threads.find((t) => t.id === sourceId)?.title ?? '未命名对话';
                const shortId = sourceId.replace(/^thread_/, '').slice(0, 8);
                const senderLabel = catStyle?.label;
                return (
                  <a
                    href={`/thread/${sourceId}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      pushThreadRouteWithHistory(sourceId, typeof window !== 'undefined' ? window : undefined);
                    }}
                    className="inline-flex items-center gap-1.5 border px-3 py-1 rounded-full bg-[#FDF6ED] border-[#E8DCCF] text-[#8D6E63] hover:bg-[#F5EDE0] transition-colors cursor-pointer w-fit max-w-full"
                    title={sourceId}
                    aria-label={`跳转到来源 thread ${sourceId}`}
                  >
                    <span className="text-[10px] font-semibold" aria-hidden>
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
        )}
        <div
          className={`border px-4 py-3 transition-transform hover:-translate-y-0.5 overflow-hidden ${
            catStyle ? `${catStyle.radius} ${catStyle.font ?? ''}` : 'bg-cafe-surface border-cafe rounded-2xl'
          } ${showSchedulerAccent ? SCHEDULER_ACCENT_BUBBLE_CLASS : ''}`}
          style={
            catStyle
              ? {
                  backgroundColor: catStyle.bgColor,
                  ...(!showSchedulerAccent ? { borderColor: catStyle.borderColor } : {}),
                }
              : undefined
          }
        >
          {hasCliBlock && isStreamOrigin ? null : !isStreamOrigin && hasBlocks ? (
            <ContentBlocks blocks={message.contentBlocks!} />
          ) : !isStreamOrigin && hasTextContent ? (
            <CollapsibleMarkdown content={message.content} className={catStyle?.font} />
          ) : message.isStreaming ? (
            <span className="text-xs text-cafe-secondary">Thinking...</span>
          ) : null}
          {message.thinking && (
            <ThinkingContent
              content={message.thinking}
              className={catStyle?.font}
              label="Thinking"
              defaultExpanded={
                bubbleRestorePending
                  ? false
                  : resolveBubbleExpanded(currentThread?.bubbleThinking, globalBubbleDefaults.thinking)
              }
              expandInExport={false}
              breedColor={catData?.color.primary}
            />
          )}
          {hasCliBlock && (
            <CliOutputBlock
              events={cliEvents}
              status={cliStatus}
              thinkingMode={currentThread?.thinkingMode}
              defaultExpanded={
                bubbleRestorePending
                  ? false
                  : resolveBubbleExpanded(currentThread?.bubbleCli, globalBubbleDefaults.cliOutput)
              }
              breedColor={catData?.color.primary}
            />
          )}
          {message.extra?.rich?.blocks && message.extra.rich.blocks.length > 0 && (
            <RichBlocks blocks={message.extra.rich.blocks} catId={message.catId} messageId={message.id} />
          )}
          {message.isStreaming && !isStreamOrigin && (
            <span className="inline-block w-1.5 h-4 bg-current animate-pulse ml-0.5 rounded-full opacity-50" />
          )}
        </div>
        {!message.isStreaming && message.metadata && <MetadataBadge metadata={message.metadata} />}
      </div>
    </div>
  );
}
