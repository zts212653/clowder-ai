export interface VoiceCaptureEvents {
  readonly onChunk: (recording: Blob) => void;
  readonly onStop: (recording: Blob) => void;
  readonly onError: (error: Error) => void;
}

/** Owns microphone lifetime only. Its host owns transcription, private drafts and explicit disposal. */
export class VoiceCapture {
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private closed = false;
  private cancelled = false;
  private started = false;
  private readonly chunks: Blob[] = [];
  constructor(private readonly events: VoiceCaptureEvents) {}

  async start(): Promise<boolean> {
    if (this.closed || this.started) return false;
    this.started = true;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.closed) {
      for (const track of stream.getTracks()) track.stop();
      return false;
    }
    this.stream = stream;
    try {
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((value) =>
        MediaRecorder.isTypeSupported(value),
      );
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      this.recorder = recorder;
      const recording = () => new Blob(this.chunks, { type: recorder.mimeType || mime || 'audio/webm' });
      recorder.addEventListener('dataavailable', (event) => {
        if (this.cancelled || !event.data.size) return;
        this.chunks.push(event.data);
        const blob = recording();
        this.events.onChunk(blob);
        if (blob.size > 50 * 1024 * 1024) this.stop();
      });
      recorder.addEventListener('stop', () => {
        this.releaseTracks();
        if (!this.cancelled) this.events.onStop(recording());
      });
      recorder.addEventListener('error', () => {
        this.stop();
        this.events.onError(new Error('Microphone recording failed'));
      });
      recorder.start(1000);
      return true;
    } catch (error) {
      this.releaseTracks();
      throw error;
    }
  }

  stop() {
    this.closed = true;
    // Stop tracks synchronously on navigation, including while the recorder's final data event is pending.
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.releaseTracks();
  }
  cancel() {
    this.cancelled = true;
    this.stop();
  }
  private releaseTracks() {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
  }
}
