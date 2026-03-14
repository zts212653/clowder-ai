'use client';

import { useEffect } from 'react';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import { LoadingIcon } from './icons/LoadingIcon';
import { MicIcon } from './icons/MicIcon';
import { SendIcon } from './icons/SendIcon';
import { StopRecordingIcon } from './icons/StopRecordingIcon';

interface ChatInputActionButtonProps {
  onTranscript: (text: string) => void;
  onSend: () => void;
  /** F39: Queue-mode send (content will be queued behind running invocation) */
  onQueueSend?: () => void;
  /** F39: Force-mode send (cancel running + execute immediately) */
  onForceSend?: () => void;
  onStop?: () => void;
  disabled?: boolean;
  sendDisabled?: boolean;
  /** Whether the thread has an active invocation (broader than disabled/isLoading) */
  hasActiveInvocation?: boolean;
  hasText: boolean;
}

/** Queue send icon — arrow into a stack/list */
function QueueSendIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h7a1 1 0 110 2H4a1 1 0 01-1-1z" />
      <path d="M15 11l3 3-3 3z" fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}

/** Renders the action button states:
 *  1. Stop generation (disabled + active invocation)
 *  2. Stop recording
 *  3. Transcribing
 *  4. Queue send (F39: active invocation + has text)
 *  5. Normal send (has text)
 *  6. Mic (default)
 *
 *  Plus voice recording status overlays (REC badge, error).
 *  Keyboard shortcut: Option+V toggles recording. */
export function ChatInputActionButton({
  onTranscript,
  onSend,
  onQueueSend,
  onForceSend,
  onStop,
  disabled,
  sendDisabled,
  hasActiveInvocation,
  hasText,
}: ChatInputActionButtonProps) {
  const voice = useVoiceInput();
  const isSendDisabled = Boolean(disabled || sendDisabled);

  useEffect(() => {
    if (voice.transcript) onTranscript(voice.transcript);
  }, [voice.transcript, onTranscript]);

  // Global keyboard shortcut: Option+V (Alt+V) toggles voice recording
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.code === 'KeyV') {
        e.preventDefault();
        if (voice.state === 'recording') {
          voice.stopRecording();
        } else if (voice.state === 'idle' && !disabled) {
          voice.startRecording();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [voice.state, voice.startRecording, voice.stopRecording, disabled]);

  // F39: Whether we're in queue mode (cat running + user has typed)
  const isQueueMode = Boolean(hasActiveInvocation && hasText && !disabled);

  return (
    <>
      {/* Voice recording status (absolute, attaches to ancestor .relative) */}
      {voice.state === 'recording' && (
        <div className="absolute top-0 right-4 -mt-6 flex items-center gap-2">
          {voice.partialTranscript && (
            <div className="px-2 py-0.5 bg-gray-800 text-white text-xs rounded-lg max-w-[240px] truncate opacity-80">
              {voice.partialTranscript}
            </div>
          )}
          <div className="px-2 py-0.5 bg-red-500 text-white text-xs rounded-full animate-pulse whitespace-nowrap">
            REC {Math.floor(voice.duration / 60)}:{String(voice.duration % 60).padStart(2, '0')}
          </div>
        </div>
      )}
      {voice.error && (
        <div className="absolute top-0 left-4 -mt-6 px-3 py-1 bg-red-100 text-red-600 text-xs rounded-lg">
          {voice.error}
        </div>
      )}

      {/* Stop button: visible alongside queue send during active invocation (not when disabled — primary stop covers it) */}
      {hasActiveInvocation && !disabled && onStop && (
        <button
          onClick={() => onStop()}
          className="p-2 rounded-lg bg-red-500/80 text-white hover:bg-red-600 transition-colors"
          title="停止生成"
          aria-label="Stop generation"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <rect x="4" y="4" width="12" height="12" rx="2" />
          </svg>
        </button>
      )}

      {/* Primary action button priority chain */}
      {disabled && onStop && hasActiveInvocation ? (
        /* Backward compat: when explicitly disabled during active invocation, Stop is the only primary action */
        <button
          onClick={() => onStop()}
          className="p-3 rounded-xl bg-red-500 text-white hover:bg-red-600 transition-colors"
          title="停止生成"
          aria-label="Stop generation"
        >
          <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
            <rect x="4" y="4" width="12" height="12" rx="2" />
          </svg>
        </button>
      ) : voice.state === 'recording' ? (
        <button
          onClick={voice.stopRecording}
          className="p-3 rounded-xl bg-red-500 text-white hover:bg-red-600 transition-colors animate-pulse"
          title="停止录音"
          aria-label="Stop recording"
        >
          <StopRecordingIcon className="w-5 h-5" />
        </button>
      ) : voice.state === 'transcribing' ? (
        <button
          disabled
          className="p-3 rounded-xl bg-gray-300 text-white cursor-wait"
          title="转写中"
          aria-label="Transcribing"
        >
          <LoadingIcon className="w-5 h-5" />
        </button>
      ) : isQueueMode && onQueueSend ? (
        /* F39: Queue send — cat is running, user typed, queue the message */
        <div className="flex items-center gap-1">
          <button
            onClick={onQueueSend}
            disabled={isSendDisabled}
            className="p-3 rounded-xl bg-[#9B7EBD] text-white hover:bg-[#8A6DAC] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="排队发送"
            title="排队发送 — 猫猫忙完后处理"
          >
            <QueueSendIcon className="w-5 h-5" />
          </button>
          {onForceSend && (
            <button
              onClick={onForceSend}
              disabled={isSendDisabled}
              className="p-2 rounded-lg text-xs text-red-500 hover:bg-red-50 disabled:opacity-40 transition-colors"
              aria-label="强制发送"
              title="强制发送 — 中断当前猫猫"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.381z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
        </div>
      ) : hasText ? (
        <button
          onClick={onSend}
          disabled={isSendDisabled}
          className="p-3 rounded-xl bg-owner-primary text-white hover:bg-owner-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="发送消息"
          aria-label="Send message"
        >
          <SendIcon className="w-5 h-5" />
        </button>
      ) : (
        <button
          onClick={voice.startRecording}
          disabled={disabled}
          className="p-3 rounded-xl text-gray-400 hover:text-owner-primary hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Start voice input (⌥V)"
          title="语音输入 (⌥V)"
        >
          <MicIcon className="w-5 h-5" />
        </button>
      )}
    </>
  );
}
