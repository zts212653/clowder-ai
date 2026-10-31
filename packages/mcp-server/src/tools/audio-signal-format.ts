export type AudioInputSignal = {
  state: string;
  reason: string;
  pcm_bytes: number;
  peak_abs: number;
  pcm_silence_s: number;
};

export function formatAudioInputSignal(signal?: AudioInputSignal): string {
  if (!signal) return '; signal=unknown (no PCM diagnostics from capture runtime)';
  return `; signal=${signal.state}; pcm=${signal.pcm_bytes} bytes; peak=${signal.peak_abs}; silence=${signal.pcm_silence_s}s; ${signal.reason}`;
}
