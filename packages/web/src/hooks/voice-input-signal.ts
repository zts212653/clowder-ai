const SAMPLE_INTERVAL_MS = 50;
const MIN_QUIET_MS = 1500;
const SIGNAL_POWER_FLOOR = 0.001 ** 2; // -60 dBFS RMS

export interface VoiceInputSignal {
  isSilent(): boolean;
  close(): void;
}

/** Inspect the same stream the recorder sees. Incomplete measurements leave ASR in charge. */
export function monitorVoiceInputSignal(stream: MediaStream): VoiceInputSignal | null {
  if (typeof AudioContext === 'undefined') return null;
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    return monitorContext(context, stream);
  } catch {
    void context?.close().catch(() => {});
    return null;
  }
}

function monitorContext(context: AudioContext, stream: MediaStream): VoiceInputSignal {
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 8192;
  source.connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  const windowSeconds = samples.length / context.sampleRate;
  const audioStart = context.currentTime;
  const wallStart = performance.now();
  let lastRead = audioStart;
  // A suspended context can miss speech at the start of the recording.
  let continuous = context.state === 'running';
  let hasSignal = false;

  function sample() {
    if (!continuous || hasSignal) return;
    const audioTime = context.currentTime;
    const wallElapsed = (performance.now() - wallStart) / 1000;
    const audioElapsed = audioTime - audioStart;
    if (
      context.state !== 'running' ||
      audioTime - lastRead > windowSeconds ||
      wallElapsed - audioElapsed > windowSeconds
    ) {
      // A stalled context or a throttled tab can hide an entire speech window.
      continuous = false;
      return;
    }
    if (audioTime <= lastRead) return;
    analyser.getFloatTimeDomainData(samples);
    lastRead = audioTime;
    let sumSquares = 0;
    for (const frame of samples) sumSquares += frame * frame;
    hasSignal = sumSquares / samples.length >= SIGNAL_POWER_FLOOR;
  }

  const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  return {
    isSilent() {
      sample();
      return continuous && !hasSignal && context.state === 'running' && (lastRead - audioStart) * 1000 >= MIN_QUIET_MS;
    },
    close() {
      clearInterval(timer);
      source.disconnect();
      analyser.disconnect();
      void context.close().catch(() => {});
    },
  };
}
