import type { TtsState } from '@/hooks/useTts';

/** F34: Tiny TTS play button for cat messages */
export function TtsPlayButton({
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
      className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 p-0.5 rounded hover:bg-cafe-surface-elevated text-cafe-muted hover:text-cafe-secondary"
      title={isPlaying ? '停止' : '播放语音'}
    >
      {isLoading ? (
        <svg width="12" height="12" viewBox="0 0 12 12" className="animate-spin">
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="20 10" />
        </svg>
      ) : (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" className={isPlaying ? 'animate-pulse' : ''} />
          <path
            d="M19.07 4.93a10 10 0 0 1 0 14.14"
            className={isPlaying ? 'animate-pulse [animation-delay:150ms]' : ''}
          />
        </svg>
      )}
    </button>
  );
}
