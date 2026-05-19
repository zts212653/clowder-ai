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
      className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 p-0.5 rounded hover:bg-black/5 text-cafe-muted hover:text-cafe-secondary"
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
