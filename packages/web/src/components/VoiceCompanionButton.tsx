'use client';

import { useCallback } from 'react';
import { useVoiceStream } from '@/hooks/useVoiceStream';
import { type PlaybackState, useVoiceSessionStore } from '@/stores/voiceSessionStore';

/**
 * F092 P0: Voice Companion toggle — icon-only header button.
 *
 * On click:
 * - Creates + resumes AudioContext (browser autoplay unlock via user gesture)
 * - Starts/stops VoiceSession bound to current thread + cat
 *
 * Visual: icon-only, matches other header buttons (ExportButton, Signal Inbox).
 * Hover tooltip: "语音陪伴" / "停止语音陪伴"
 */

/** Unlock browser autoplay by playing a silent HTMLAudioElement.
 *
 *  iOS requires the *same* audio subsystem used for later playback to be
 *  "unlocked" within a user-gesture handler.  The old implementation used
 *  AudioContext (Web Audio API) which does NOT unlock HTMLAudioElement
 *  autoplay on iOS — the two subsystems are independent.
 *
 *  Fix (F124 Phase A): play a tiny silent WAV via HTMLAudioElement so that
 *  subsequent `new Audio(url).play()` calls (in useVoiceAutoPlay) are
 *  permitted by the browser.
 *
 *  Returns true if the play() promise resolved, false otherwise. */
function unlockAutoplay(): boolean {
  try {
    // Minimal valid WAV: 44-byte header + 1 sample of silence
    // prettier-ignore
    const silentWav = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46,
      0x25,
      0x00,
      0x00,
      0x00, // RIFF, size=37
      0x57,
      0x41,
      0x56,
      0x45,
      0x66,
      0x6d,
      0x74,
      0x20, // WAVEfmt
      0x10,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00, // PCM, mono
      0x44,
      0xac,
      0x00,
      0x00,
      0x88,
      0x58,
      0x01,
      0x00, // 44100 Hz
      0x02,
      0x00,
      0x10,
      0x00,
      0x64,
      0x61,
      0x74,
      0x61, // 16-bit, data
      0x02,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // 1 silent sample
    ]);
    const blob = new Blob([silentWav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    // play() returns a promise; fire-and-forget within the gesture handler
    // is sufficient — iOS unlocks the HTMLAudioElement subsystem as soon as
    // play() is called synchronously inside a click handler.
    audio
      .play()
      .then(() => {
        audio.pause();
        URL.revokeObjectURL(url);
      })
      .catch(() => {
        URL.revokeObjectURL(url);
      });
    return true;
  } catch {
    return false;
  }
}

interface VoiceCompanionButtonProps {
  threadId: string;
  /** Default cat to bind to (first target cat or 'opus') */
  defaultCatId: string;
}

function VoicePlaybackControls({ playbackState }: { playbackState: PlaybackState }) {
  const { pause, resume, skip } = useVoiceStream();
  const isPaused = playbackState === 'paused';

  return (
    <>
      <button
        type="button"
        onClick={isPaused ? resume : pause}
        className="p-1 rounded-lg text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
        aria-label={isPaused ? '继续播放' : '暂停'}
        title={isPaused ? '继续播放' : '暂停'}
      >
        {isPaused ? (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        ) : (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
          </svg>
        )}
      </button>
      <button
        type="button"
        onClick={skip}
        className="p-1 rounded-lg text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
        aria-label="跳过当前"
        title="跳过当前"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
        </svg>
      </button>
    </>
  );
}

export function VoiceCompanionButton({ threadId, defaultCatId }: VoiceCompanionButtonProps) {
  const session = useVoiceSessionStore((s) => s.session);
  const start = useVoiceSessionStore((s) => s.start);
  const stop = useVoiceSessionStore((s) => s.stop);

  const isActive = session?.voiceMode && session.boundThreadId === threadId;
  const playbackState = session?.playbackState ?? 'idle';

  const handleClick = useCallback(() => {
    if (isActive) {
      stop();
    } else {
      const unlocked = unlockAutoplay();
      start(threadId, defaultCatId, unlocked);
    }
  }, [isActive, threadId, defaultCatId, start, stop]);

  return (
    <div className="flex items-center gap-0.5">
      {isActive && (playbackState === 'playing' || playbackState === 'paused') && (
        <VoicePlaybackControls playbackState={playbackState} />
      )}
      <button
        type="button"
        onClick={handleClick}
        className={`
          p-1 rounded-lg transition-colors
          ${
            isActive
              ? 'text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20'
              : 'text-gray-500 hover:bg-owner-light'
          }
        `}
        aria-label={isActive ? '停止语音陪伴' : '语音陪伴'}
        title={isActive ? '停止语音陪伴' : '语音陪伴'}
      >
        <svg
          className={`w-5 h-5${isActive ? ' animate-pulse' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
          <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
        </svg>
      </button>
    </div>
  );
}
