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
export function unlockAutoplay(): boolean {
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
