export function VoiceInputButton({
  state,
  available = true,
  disabled,
  language = 'zh',
  onStart,
  onStop,
  className,
}: {
  readonly state: 'idle' | 'recording' | 'transcribing';
  readonly available?: boolean;
  readonly disabled?: boolean;
  readonly language?: 'zh' | 'en';
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly className?: string;
}) {
  const en = language === 'en';
  const label = !available
    ? en
      ? 'Voice input is not available on this device'
      : '这台设备上还不能语音输入'
    : state === 'recording'
      ? en
        ? 'Stop recording'
        : '停止录音'
      : state === 'transcribing'
        ? en
          ? 'Transcribing…'
          : '正在转成文字…'
        : en
          ? 'Voice input'
          : '语音输入';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-voice-state={state}
      className={`cafe-voice-input ${className ?? ''}`}
      disabled={!available || state === 'transcribing' || (state !== 'recording' && disabled)}
      onClick={state === 'recording' ? onStop : onStart}
    >
      {state === 'recording' ? (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="5" y="5" width="10" height="10" rx="1" fill="currentColor" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 20 20"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <rect x="7" y="2" width="6" height="11" rx="3" />
          <path d="M4 9v1a6 6 0 0 0 12 0V9m-6 7v2m-3 0h6" />
        </svg>
      )}
    </button>
  );
}
