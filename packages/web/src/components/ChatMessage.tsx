'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { type TtsState, useTts } from '@/hooks/useTts';
import { hexToRgba, tintedLight } from '@/lib/color-utils';
import { getMentionRe, getMentionToCat } from '@/lib/mention-highlight';
import { parseDirection } from '@/lib/parse-direction';
import { type ChatMessage as ChatMessageType, type MessageContent, useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { CatAvatar } from './CatAvatar';
import { ConnectorBubble } from './ConnectorBubble';
import { CliOutputBlock } from './cli-output/CliOutputBlock';
import { toCliEvents } from './cli-output/toCliEvents';
import { DirectionPill } from './DirectionPill';
import { EvidencePanel } from './EvidencePanel';
import { GovernanceBlockedCard } from './GovernanceBlockedCard';
import { Lightbox } from './Lightbox';
import { MarkdownContent } from './MarkdownContent';
import { MetadataBadge } from './MetadataBadge';
import { ReplyPill } from './ReplyPill';
import { RichBlocks } from './rich/RichBlocks';
import { SummaryCard } from './SummaryCard';
import { ThinkingContent } from './ThinkingContent';
import { TimeoutDiagnosticsPanel } from './TimeoutDiagnosticsPanel';

/** Breed-level aesthetics — only changes when a new BREED is added */
const BREED_STYLES: Record<string, { radius: string; font?: string }> = {
  ragdoll: { radius: 'rounded-2xl rounded-bl-sm' },
  'maine-coon': { radius: 'rounded-2xl rounded-br-sm', font: 'font-mono' },
  siamese: { radius: 'rounded-2xl rounded-tr-sm' },
  'dragon-li': { radius: 'rounded-lg rounded-tl-sm', font: 'font-mono' },
};
const DEFAULT_BREED_STYLE = { radius: 'rounded-2xl' };

function ContentBlocks({ blocks }: { blocks: MessageContent[] }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === 'text') {
          return <MarkdownContent key={i} content={block.text} />;
        }
        if (block.type === 'image') {
          const src = block.url.startsWith('/uploads/') ? `${API_URL}${block.url}` : block.url;
          return (
            // biome-ignore lint/performance/noImgElement: uploaded images cannot use next/image
            <img
              key={i}
              src={src}
              alt="attached image"
              className="max-w-full sm:max-w-sm rounded-lg mt-2 border border-gray-200 cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => setLightboxSrc(src)}
            />
          );
        }
        return null;
      })}
      {lightboxSrc && <Lightbox url={lightboxSrc} alt="attached image" onClose={() => setLightboxSrc(null)} />}
    </>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** F098-D: Threshold (ms) for showing dual timestamp. Gap <= this uses single timestamp. */
const DELIVERED_AT_GAP_THRESHOLD = 5000;

/** F098-D: Format dual timestamp when deliveredAt gap is significant. */
function formatDualTime(timestamp: number, deliveredAt?: number): string {
  if (!deliveredAt || deliveredAt - timestamp <= DELIVERED_AT_GAP_THRESHOLD) {
    return formatTime(timestamp);
  }
  return `发送 ${formatTime(timestamp)} · 收到 ${formatTime(deliveredAt)}`;
}

/** F34: Tiny TTS play button for cat messages */
function TtsPlayButton({
  messageId,
  text,
  catId,
  ttsState,
  activeMessageId,
  onSynthesize,
}: {
  messageId: string;
  text: string;
  catId: string;
  ttsState: TtsState;
  activeMessageId: string | null;
  onSynthesize: (messageId: string, text: string, catId?: string) => void;
}) {
  const isActive = activeMessageId === messageId;
  const isLoading = isActive && ttsState === 'loading';
  const isPlaying = isActive && ttsState === 'playing';

  return (
    <button
      onClick={() => onSynthesize(messageId, text, catId)}
      disabled={isLoading}
      className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 p-0.5 rounded hover:bg-black/5 text-gray-400 hover:text-gray-600"
      title={isPlaying ? '停止' : '播放语音'}
    >
      {isLoading ? (
        <svg width="12" height="12" viewBox="0 0 12 12" className="animate-spin">
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="20 10" />
        </svg>
      ) : isPlaying ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <rect x="2" y="1" width="3" height="10" rx="0.5" />
          <rect x="7" y="1" width="3" height="10" rx="0.5" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <path d="M2.5 1L10.5 6L2.5 11V1Z" />
        </svg>
      )}
    </button>
  );
}

interface ChatMessageProps {
  message: ChatMessageType;
  getCatById: (id: string) => CatData | undefined;
}

export function ChatMessage({ message, getCatById }: ChatMessageProps) {
  const router = useRouter();
  const { state: ttsState, synthesize: ttsSynthesize, activeMessageId } = useTts();
  const threads = useChatStore((s) => s.threads);
  const uiThinkingExpandedByDefault = useChatStore((s) => s.uiThinkingExpandedByDefault);
  const isUser = message.type === 'user' && !message.catId;
  const isSystem = message.type === 'system';
  const isSummary = message.type === 'summary';
  const isConnector = message.type === 'connector';

  // Dynamic cat data lookup — works for any catId in cat-config.json
  const catData = message.catId ? getCatById(message.catId) : undefined;
  const catStyle = catData
    ? (() => {
        const breed = BREED_STYLES[catData.breedId ?? ''] ?? DEFAULT_BREED_STYLE;
        const idLabel = catData.id.charAt(0).toUpperCase() + catData.id.slice(1);
        const label = catData.variantLabel
          ? `${catData.displayName}（${catData.variantLabel}）`
          : `${catData.displayName}（${idLabel}）`;
        // F098-A5: callback messages get subtle tinted bubble; stream/other keep breed secondary
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
  const hasBlocks = message.contentBlocks && message.contentBlocks.length > 0;
  const hasTextContent = message.content.trim().length > 0;
  const isWhisper = message.visibility === 'whisper';
  const isRevealed = isWhisper && !!message.revealedAt;

  // F098: Direction info for pill badge
  const direction = catData ? parseDirection(message, () => ({ toCat: getMentionToCat(), re: getMentionRe() })) : null;

  // F097: CLI Output Block — merge tool events + stream content into unified CliEvent[]
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
    if (message.variant === 'evidence' && message.evidence) {
      return <EvidencePanel data={message.evidence} />;
    }

    if (message.variant === 'governance_blocked' && message.extra?.governanceBlocked) {
      const { projectPath, reasonKind, invocationId } = message.extra.governanceBlocked;
      return <GovernanceBlockedCard projectPath={projectPath} reasonKind={reasonKind} invocationId={invocationId} />;
    }

    // F045: variant='thinking' is deprecated — thinking is now embedded in assistant bubbles.
    // Legacy standalone thinking messages fall through to normal system rendering.

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
      ? 'text-gray-400 bg-gray-50/50 font-mono text-xs py-1'
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
    return <ConnectorBubble message={message} />;
  }

  if (isUser) {
    return (
      <div data-message-id={message.id} className="flex justify-end gap-2 mb-4 items-start">
        <div className="max-w-[75%]">
          <div className="flex justify-end items-center gap-2 mb-1">
            {isWhisper && (
              <span
                className={`text-xs px-1.5 py-0.5 rounded ${isRevealed ? 'bg-gray-100 text-gray-500' : 'bg-amber-100 text-amber-600'}`}
              >
                {isRevealed ? '已揭秘' : `悄悄话 → ${message.whisperTo?.join(', ') ?? ''}`}
              </span>
            )}
            {message.replyTo && message.replyPreview && (
              <ReplyPill replyPreview={message.replyPreview} replyToId={message.replyTo} getCatById={getCatById} />
            )}
            <span className="text-xs text-gray-400">{formatDualTime(message.timestamp, message.deliveredAt)}</span>
            <span className="text-xs font-semibold text-owner-dark">铲屎官</span>
          </div>
          <div
            className={`rounded-2xl rounded-br-sm px-4 py-3 transition-transform hover:-translate-y-0.5 ${
              isWhisper && !isRevealed
                ? 'bg-amber-50 text-amber-900 border border-dashed border-amber-300'
                : 'bg-owner-light text-owner-dark'
            }`}
          >
            {hasBlocks ? (
              <ContentBlocks blocks={message.contentBlocks!} />
            ) : (
              <MarkdownContent content={message.content} />
            )}
          </div>
        </div>
        <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 ring-2 ring-owner-light bg-owner-primary flex items-center justify-center">
          <img
            src="/avatars/owner.jpg"
            alt="铲屎官"
            width={32}
            height={32}
            className="object-cover w-full h-full"
            onError={(e) => {
              // Fallback: hide broken image, show background color
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
      </div>
    );
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
              <span className="text-xs text-gray-400">{formatTime(message.timestamp)}</span>
              {isWhisper && (
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${isRevealed ? 'bg-gray-100 text-gray-500' : 'bg-amber-100 text-amber-600'}`}
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
              {message.replyTo && message.replyPreview && (
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
                      router.push(`/thread/${sourceId}`);
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
            catStyle ? `${catStyle.radius} ${catStyle.font ?? ''}` : 'bg-white border-gray-200 rounded-2xl'
          }`}
          style={
            catStyle
              ? {
                  backgroundColor: catStyle.bgColor,
                  borderColor: catStyle.borderColor,
                }
              : undefined
          }
        >
          {/* F097: Content first, then Thinking (reasoning before execution), then CLI output */}
          {/* 1. Content — callback messages or non-stream text shown as normal content.
              If CLI block exists, text is already inside it — never render outside. */}
          {hasCliBlock && isStreamOrigin ? null : !isStreamOrigin && hasBlocks ? (
            <ContentBlocks blocks={message.contentBlocks!} />
          ) : !isStreamOrigin && hasTextContent ? (
            <MarkdownContent content={message.content} className={catStyle?.font} />
          ) : message.isStreaming ? (
            <span className="text-xs text-gray-500">Thinking...</span>
          ) : null}
          {/* 2. 🧠 Thinking — reasoning happens before tool execution (AC-A3) */}
          {message.thinking && (
            <ThinkingContent
              content={message.thinking}
              className={catStyle?.font}
              label="Thinking"
              defaultExpanded={uiThinkingExpandedByDefault}
              expandInExport={false}
              breedColor={catData?.color.primary}
            />
          )}
          {/* 3. CLI Output Block — tools + stream content merged */}
          {hasCliBlock && (
            <CliOutputBlock
              events={cliEvents}
              status={cliStatus}
              thinkingMode={currentThread?.thinkingMode}
              defaultExpanded={uiThinkingExpandedByDefault}
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
