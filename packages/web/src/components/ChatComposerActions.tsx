'use client';

import { VoiceInputButton } from '@cat-cafe/ui';
import type { useVoiceInput } from '@/hooks/useVoiceInput';
import { AppTooltip } from './AppTooltip';
import { chatComposerCopy } from './chat-composer.shell-copy';
import { useShellCopy } from './shell/shell-copy';
import { useShellLanguage } from './shell/shell-language';

type StopState = 'available' | 'pending' | 'unavailable' | 'hidden';
interface ChatComposerActionsProps {
  voice: ReturnType<typeof useVoiceInput>;
  hasText: boolean;
  disabled?: boolean;
  sendDisabled?: boolean;
  showStop: boolean;
  stopState: StopState;
  onStop?: () => void;
  onSend: () => void;
}

const control =
  'shell-focusable flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40';

function ComposerVoiceControl({ voice, disabled }: Pick<ChatComposerActionsProps, 'voice' | 'disabled'>) {
  const t = useShellCopy(chatComposerCopy);
  const recording = voice.state === 'recording';
  const transcribing = voice.state === 'transcribing';
  const label = recording ? t.stopRecording : transcribing ? t.transcribing : t.voice;
  const language = useShellLanguage();
  return (
    <AppTooltip label={label} side="top" shortcut={recording || transcribing ? undefined : '⌥V'}>
      <VoiceInputButton
        language={language}
        state={voice.state}
        disabled={disabled}
        onStart={voice.startRecording}
        onStop={voice.stopRecording}
        className={control}
      />
    </AppTooltip>
  );
}

/** v2 keeps recording separate from sending. The parent retains voice, queue and steer ownership. */
export function ChatComposerActions({
  voice,
  hasText,
  disabled,
  sendDisabled,
  showStop,
  stopState,
  onStop,
  onSend,
}: ChatComposerActionsProps) {
  const t = useShellCopy(chatComposerCopy);
  const stopLabel = {
    available: t.stop,
    pending: t.stopping,
    unavailable: t.stopUnavailable,
    hidden: t.stop,
  }[stopState];
  const stop = (
    <AppTooltip label={stopLabel} side="top">
      <button
        type="button"
        aria-label={stopLabel}
        onClick={onStop}
        disabled={stopState !== 'available' || !onStop}
        className={`${control} bg-conn-red-text text-[var(--cafe-accent-foreground)] hover:bg-conn-red-hover disabled:cursor-wait`}
      >
        <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <rect x="4" y="4" width="12" height="12" rx="2" />
        </svg>
      </button>
    </AppTooltip>
  );
  if (disabled && showStop) return stop;

  const inputBusy = disabled || sendDisabled || voice.state === 'recording' || voice.state === 'transcribing';
  const sendLabel = t.send;

  return (
    <>
      <ComposerVoiceControl voice={voice} disabled={disabled} />
      {!hasText && showStop ? (
        stop
      ) : (
        <AppTooltip label={t.send} side="top">
          <button
            type="button"
            onClick={onSend}
            disabled={inputBusy || !hasText}
            aria-label={sendLabel}
            className={`${control} bg-[var(--shell-primary)] text-[var(--shell-primary-on)] hover:brightness-95`}
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10 16V4m-5 5 5-5 5 5" />
            </svg>
          </button>
        </AppTooltip>
      )}
    </>
  );
}
