import { parsePcm16Wav } from '@cat-cafe/shared';

type ReadAloudChunk = {
  chunkIndex: number;
  audioBase64: string;
  isFinalChunk: boolean;
};

interface ScheduledAudio {
  buffer: AudioBuffer;
  sentence: number;
}

interface ReadAloudOutput {
  playing: (active: boolean) => void;
  complete: () => void;
  error: () => void;
}

const START_LEAD_SEC = 0.035;
const MIN_FIRST_PACKET_SEC = 0.35;
const FIRST_PACKET_OVERHEAD_MS = 80;

/** One output clock for the chunks and complete assets of a chat read-aloud. */
export class ReadAloudPcm {
  private scheduled = new Map<AudioBufferSourceNode, ScheduledAudio>();
  private pendingFirst?: { buffer: AudioBuffer; receivedAt: number };
  private nextStart = 0;
  private sentence = 0;
  private skippedSentence = -1;
  private chunkCount = 0;
  private streamingSentence = false;
  private waitForAsset = false;
  private sealed = false;
  private paused = false;
  private closed = false;

  constructor(
    private readonly context: AudioContext,
    private readonly output: ReadAloudOutput,
    private sentenceStartedAt = performance.now(),
  ) {
    // Resume the device while the read-aloud request is producing its first packet.
    void context.resume().catch(() => {});
  }

  get ready(): boolean {
    return this.context.state === 'running';
  }

  pushChunk(chunk: ReadAloudChunk, now = performance.now()): void {
    if (this.closed || this.waitForAsset || this.sentence <= this.skippedSentence) return;
    const buffer = chunk.chunkIndex === this.chunkCount ? this.decodeChunk(chunk.audioBase64) : null;
    if (!buffer) {
      if (this.streamingSentence) throw new Error('Read-aloud PCM changed format or arrived out of order');
      this.waitForAsset = true;
      return;
    }
    this.chunkCount++;
    if (this.streamingSentence) {
      this.schedule(buffer, this.sentence);
    } else {
      this.prime(buffer, chunk.isFinalChunk, now);
    }
  }

  private prime(buffer: AudioBuffer, final: boolean, now: number): void {
    if (this.pendingFirst) {
      // A late first packet can still be followed by a real-time producer.
      const first = this.pendingFirst;
      this.pendingFirst = undefined;
      if (final || now - first.receivedAt <= first.buffer.duration * 850) {
        this.streamingSentence = true;
        this.schedule(first.buffer, this.sentence);
        this.schedule(buffer, this.sentence);
      } else {
        this.waitForAsset = true;
      }
    } else if (
      final ||
      (buffer.duration >= MIN_FIRST_PACKET_SEC &&
        now - this.sentenceStartedAt <= buffer.duration * 1000 + FIRST_PACKET_OVERHEAD_MS)
    ) {
      this.streamingSentence = true;
      this.schedule(buffer, this.sentence);
    } else {
      this.pendingFirst = { buffer, receivedAt: now };
    }
  }

  async finishSentence(pcmChunkCount: number | undefined, fetchAsset: () => Promise<ArrayBuffer>): Promise<void> {
    if (this.closed) return;
    if (this.sentence > this.skippedSentence) {
      if (this.streamingSentence) {
        if (pcmChunkCount !== this.chunkCount) throw new Error('Read-aloud PCM sentence was incomplete');
      } else {
        const audio = await fetchAsset();
        if (this.closed) return;
        const buffer = await this.context.decodeAudioData(audio);
        if (!this.closed && this.sentence > this.skippedSentence) this.schedule(buffer, this.sentence);
      }
    }
    this.sentence++;
    this.sentenceStartedAt = performance.now();
    this.pendingFirst = undefined;
    this.chunkCount = 0;
    this.streamingSentence = false;
    this.waitForAsset = false;
  }

  finish(): void {
    this.sealed = true;
    this.onDrained();
  }

  pause(): void {
    this.paused = true;
    void this.context.suspend().catch(this.output.error);
  }

  resume(): void {
    this.paused = false;
    void this.context.resume().catch(this.output.error);
    if (this.scheduled.size) this.output.playing(true);
  }

  skip(): void {
    const first = this.scheduled.values().next().value;
    if (!first) return;
    this.skippedSentence = first.sentence;
    const later = [...this.scheduled.values()].filter((entry) => entry.sentence > first.sentence);
    this.stopNodes();
    this.nextStart = 0;
    for (const entry of later) this.schedule(entry.buffer, entry.sentence);
    this.onDrained();
  }

  close(): void {
    this.closed = true;
    this.stopNodes();
    void this.context.close().catch(() => {});
  }

  private decodeChunk(base64: string): AudioBuffer | null {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const wav = parsePcm16Wav(bytes);
    if (!wav || wav.channels !== 1 || wav.blockAlign !== 2 || wav.dataSize === 0) return null;
    const buffer = this.context.createBuffer(1, wav.dataSize / 2, wav.sampleRate);
    const data = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < data.length; i++) data[i] = view.getInt16(wav.dataOffset + i * 2, true) / 32768;
    return buffer;
  }

  private schedule(buffer: AudioBuffer, sentence: number): void {
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.context.destination);
    const now = this.context.currentTime;
    const start = this.nextStart >= now && this.nextStart > 0 ? this.nextStart : now + START_LEAD_SEC;
    node.start(start);
    this.nextStart = start + buffer.duration;
    this.scheduled.set(node, { buffer, sentence });
    node.onended = () => {
      this.scheduled.delete(node);
      node.disconnect();
      this.onDrained();
    };
    if (!this.paused) this.output.playing(true);
  }

  private onDrained(): void {
    if (this.closed || this.scheduled.size > 0) return;
    if (this.sealed) this.output.complete();
    else this.output.playing(false);
  }

  private stopNodes(): void {
    for (const node of this.scheduled.keys()) {
      node.onended = null;
      node.stop();
      node.disconnect();
    }
    this.scheduled.clear();
  }
}
