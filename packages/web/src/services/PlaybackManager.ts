import type { VoiceChunkEvent, VoiceStreamEndEvent, VoiceStreamStartEvent } from '@cat-cafe/shared';

export type PlaybackManagerState = 'idle' | 'playing' | 'paused';
export type PlaybackSource = 'voice' | 'podcast' | 'listen';
export type EnqueueUrlResult = 'enqueued' | 'failed' | 'cancelled';

export interface PlaybackSnapshot {
  state: PlaybackManagerState;
  source: PlaybackSource | null;
  itemIndex: number;
  currentTime: number;
  duration: number;
  playbackRate: number;
}

export interface PlaybackManagerCallbacks {
  onStateChange: (state: PlaybackManagerState) => void;
  /** Called each time a queued item finishes, with the 0-based index of the completed item within a batch. */
  onItemEnd?: (index: number) => void;
}

let domAudio: HTMLAudioElement | null = null;

interface PlaybackEntry {
  url: string;
  completesItem: boolean;
  durationSec?: number;
}

function getDomAudio(): HTMLAudioElement {
  if (domAudio) return domAudio;
  const el = document.createElement('audio');
  el.id = 'voice-stream-audio';
  el.style.display = 'none';
  el.preload = 'auto';
  document.body.appendChild(el);
  domAudio = el;
  return el;
}

export class PlaybackManager {
  private queue: PlaybackEntry[] = [];
  private blobUrls: string[] = [];
  private activeEntry: PlaybackEntry | null = null;
  private itemElapsed = 0;
  private state: PlaybackManagerState = 'idle';
  private activeInvocationId: string | null = null;
  private streamDone = false;
  private firstChunkPlayed = false;
  private callbacks: PlaybackManagerCallbacks;
  private source: PlaybackSource | null = null;
  private playbackRate = 1;
  private pendingSeekSeconds: number | null = null;
  private listeners = new Set<(snapshot: PlaybackSnapshot) => void>();
  /** Track completed items within a batch (for podcast progress tracking). */
  private batchItemIndex = 0;
  private batchMode = false;
  /** Monotonically increasing ID to invalidate in-flight fetches after interrupt/new batch. */
  private batchId = 0;

  constructor(callbacks: PlaybackManagerCallbacks) {
    this.callbacks = callbacks;
  }

  handleStreamStart(event: VoiceStreamStartEvent): void {
    if (this.source !== null && (this.source !== 'voice' || this.activeInvocationId !== event.invocationId)) {
      this.interrupt();
    }
    this.source = 'voice';
    this.activeInvocationId = event.invocationId;
    this.streamDone = false;
    this.firstChunkPlayed = false;
    this.batchMode = false;
    this.emitSnapshot();
  }

  handleChunk(event: VoiceChunkEvent): void {
    if (event.invocationId !== this.activeInvocationId) return;

    const mimeType = event.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    const binary = atob(event.audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    this.blobUrls.push(blobUrl);

    if (!this.firstChunkPlayed && this.state !== 'paused') {
      this.firstChunkPlayed = true;
      this.playEntry({ url: blobUrl, completesItem: true });
    } else if (this.state === 'idle') {
      this.playEntry({ url: blobUrl, completesItem: true });
    } else {
      this.queue.push({ url: blobUrl, completesItem: true });
      const audio = getDomAudio();
      if (audio.ended && this.state === 'playing') {
        this.playNext();
      }
    }
  }

  handleStreamEnd(event: VoiceStreamEndEvent): void {
    if (event.invocationId !== this.activeInvocationId) return;
    this.streamDone = true;

    if (event.totalChunks === -1) {
      this.interrupt();
      return;
    }

    const audio = getDomAudio();
    if (this.queue.length === 0 && (!this.firstChunkPlayed || audio.ended)) {
      this.setState('idle');
    }
  }

  /**
   * Enqueue a remote audio URL for playback (e.g. podcast segment).
   * Fetches the URL, creates a blob URL, and adds to the playback queue.
   * The returned promise distinguishes a successful enqueue, a transfer failure, and batch cancellation.
   * @param fetchFn - Fetch function that returns a Response (allows passing auth-aware fetchers like apiFetch).
   */
  async enqueueUrl(url: string, fetchFn: (url: string) => Promise<Response> = fetch): Promise<EnqueueUrlResult> {
    const capturedBatchId = this.batchId;
    let res: Response;
    try {
      res = await fetchFn(url);
    } catch (err) {
      if (this.batchId !== capturedBatchId) return 'cancelled';
      console.error('[PlaybackManager] enqueueUrl fetch rejected:', err);
      return 'failed';
    }
    if (this.batchId !== capturedBatchId) return 'cancelled';
    if (!res.ok) {
      console.error(`[PlaybackManager] enqueueUrl fetch failed: ${res.status}`);
      return 'failed';
    }
    let blob: Blob;
    try {
      blob = await res.blob();
    } catch (err) {
      if (this.batchId !== capturedBatchId) return 'cancelled';
      console.error('[PlaybackManager] enqueueUrl blob() rejected:', err);
      return 'failed';
    }
    if (this.batchId !== capturedBatchId) return 'cancelled';
    const blobUrl = URL.createObjectURL(blob);
    this.blobUrls.push(blobUrl);
    this.enqueueEntry({ url: blobUrl, completesItem: true });
    return 'enqueued';
  }

  /** Enqueue a native TTS stream chunk while preserving one logical sentence boundary. */
  enqueueBase64(audioBase64: string, format: string, options: { completesItem: boolean; durationSec?: number }): void {
    const binary = atob(audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const mimeType = format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    this.blobUrls.push(blobUrl);
    this.enqueueEntry({
      url: blobUrl,
      completesItem: options.completesItem,
      ...(options.durationSec != null ? { durationSec: options.durationSec } : {}),
    });
  }

  /**
   * Start a batch playback session (e.g. podcast "play all").
   * Interrupts any ongoing playback, enters batch mode, then enqueues URLs sequentially.
   * @param urls - Audio URLs to play in order.
   * @param fetchFn - Auth-aware fetch function.
   * @returns A promise that resolves when all URLs are enqueued (playback may still be ongoing).
   */
  async startBatch(urls: string[], fetchFn: (url: string) => Promise<Response> = fetch): Promise<void> {
    this.beginBatch('podcast');
    const capturedBatchId = this.batchId;
    for (const url of urls) {
      if (this.batchId !== capturedBatchId) return;
      await this.enqueueUrl(url, fetchFn);
    }
    if (this.batchId !== capturedBatchId) return;
    this.streamDone = true;
    const audio = getDomAudio();
    if (this.queue.length === 0 && audio.ended && this.state === 'playing') {
      this.setState('idle');
    }
  }

  /** Begin an incrementally-filled batch owned by one audio source. */
  beginBatch(source: Exclude<PlaybackSource, 'voice'>): void {
    this.interrupt();
    this.batchId++;
    this.source = source;
    this.batchMode = true;
    this.batchItemIndex = 0;
    this.itemElapsed = 0;
    this.activeEntry = null;
    this.streamDone = false;
    this.emitSnapshot();
  }

  /** Whether a batch playback is currently active. */
  isBatchActive(): boolean {
    return this.batchMode;
  }

  /** Register a temporary onItemEnd callback (returns unsubscribe fn). */
  onItemEnd(fn: (index: number) => void): () => void {
    const prev = this.callbacks.onItemEnd;
    this.callbacks.onItemEnd = (index: number) => {
      prev?.(index);
      fn(index);
    };
    return () => {
      this.callbacks.onItemEnd = prev;
    };
  }

  /** Register a temporary onStateChange wrapper (returns unsubscribe fn). */
  onStateIdle(fn: () => void): () => void {
    const orig = this.callbacks.onStateChange;
    this.callbacks.onStateChange = (state) => {
      orig(state);
      if (state === 'idle') fn();
    };
    return () => {
      this.callbacks.onStateChange = orig;
    };
  }

  /** Mark the current queue as complete (no more items will be enqueued). */
  markDone(): void {
    this.streamDone = true;
  }

  setPlaybackRate(rate: number): void {
    this.playbackRate = rate;
    getDomAudio().playbackRate = rate;
    this.emitSnapshot();
  }

  seek(seconds: number): void {
    this.pendingSeekSeconds = Math.max(0, seconds);
    this.applyPendingSeek();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    const audio = getDomAudio();
    audio.pause();
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    const audio = getDomAudio();
    if (audio.src) {
      audio.play().catch(() => this.setState('idle'));
      this.setState('playing');
    } else if (this.queue.length > 0) {
      this.playNext();
    } else {
      this.setState('idle');
    }
  }

  skip(): void {
    const audio = getDomAudio();
    audio.pause();
    audio.removeAttribute('src');
    audio.onended = null;
    audio.ontimeupdate = null;
    audio.ondurationchange = null;
    audio.onloadedmetadata = null;
    if (this.queue.length > 0) {
      this.playNext();
    } else if (this.streamDone) {
      this.setState('idle');
    } else {
      // Stream still going, no next chunk yet — enter idle to wait.
      // handleChunk() will auto-resume when a new chunk arrives.
      this.setState('idle');
    }
  }

  interrupt(): void {
    this.batchId++;
    const audio = getDomAudio();
    audio.pause();
    audio.removeAttribute('src');
    audio.onended = null;
    audio.onerror = null;
    this.queue = [];
    this.cleanupBlobUrls();
    this.activeInvocationId = null;
    this.streamDone = false;
    this.firstChunkPlayed = false;
    this.batchMode = false;
    this.batchItemIndex = 0;
    this.itemElapsed = 0;
    this.activeEntry = null;
    this.source = null;
    this.pendingSeekSeconds = null;
    this.setState('idle');
    this.emitSnapshot();
  }

  destroy(): void {
    this.interrupt();
  }

  getState(): PlaybackManagerState {
    return this.state;
  }

  getActiveInvocationId(): string | null {
    return this.activeInvocationId;
  }

  getSnapshot(): PlaybackSnapshot {
    const audio = getDomAudio();
    const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    return {
      state: this.state,
      source: this.source,
      itemIndex: this.batchItemIndex,
      currentTime: this.batchMode ? this.itemElapsed + currentTime : currentTime,
      duration: this.batchMode ? this.logicalItemDuration(duration) : duration,
      playbackRate: this.playbackRate,
    };
  }

  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  private enqueueEntry(entry: PlaybackEntry): void {
    const audio = getDomAudio();
    if (this.state === 'idle' || (this.state === 'playing' && audio.ended)) this.playEntry(entry);
    else this.queue.push(entry);
  }

  private playEntry(entry: PlaybackEntry): void {
    const audio = getDomAudio();
    this.activeEntry = entry;
    audio.src = entry.url;
    audio.currentTime = 0;
    audio.playbackRate = this.playbackRate;
    audio.onloadedmetadata = () => this.applyPendingSeek();
    audio.ontimeupdate = () => this.emitSnapshot();
    audio.ondurationchange = () => this.emitSnapshot();
    audio.onended = () => {
      if (this.batchMode) {
        if (entry.completesItem) {
          this.callbacks.onItemEnd?.(this.batchItemIndex);
          this.batchItemIndex++;
          this.itemElapsed = 0;
        } else {
          this.itemElapsed += this.entryDuration(entry, audio.duration);
        }
        this.emitSnapshot();
      }
      this.playNext();
    };
    audio.onerror = () => {
      console.error('[PlaybackManager] Audio playback error');
      if (this.batchMode && entry.completesItem) {
        this.batchItemIndex++;
        this.itemElapsed = 0;
        this.emitSnapshot();
      }
      this.playNext();
    };
    this.setState('playing');
    audio.play().catch(() => {
      console.error('[PlaybackManager] play() rejected');
      this.setState('idle');
    });
  }

  private playNext(): void {
    const next = this.queue.shift();
    if (next) {
      this.playEntry(next);
    } else if (this.streamDone) {
      this.activeEntry = null;
      if (this.batchMode) {
        this.batchMode = false;
        this.batchItemIndex = 0;
        this.source = null;
      }
      this.setState('idle');
    } else {
      this.activeEntry = null;
      // The current item ended before the next streamed/batch item arrived.
      // Retain source ownership, but report the audible truth: nothing is
      // playing until enqueueUrl()/handleChunk() resumes the batch.
      this.setState('idle');
    }
  }

  private setState(newState: PlaybackManagerState): void {
    if (this.state === newState) return;
    this.state = newState;
    this.callbacks.onStateChange(newState);
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private applyPendingSeek(): void {
    if (this.pendingSeekSeconds == null) return;
    const audio = getDomAudio();
    if (audio.readyState < 1) return;
    const entryDuration = this.entryDuration(this.activeEntry, audio.duration);
    const remaining = Math.max(0, this.pendingSeekSeconds - this.itemElapsed);
    if (this.batchMode && this.activeEntry && !this.activeEntry.completesItem && remaining >= entryDuration) {
      this.itemElapsed += entryDuration;
      audio.pause();
      audio.removeAttribute('src');
      this.playNext();
      return;
    }
    audio.currentTime = Math.min(remaining, entryDuration || remaining);
    this.pendingSeekSeconds = null;
    this.emitSnapshot();
  }

  private entryDuration(entry: PlaybackEntry | null, audioDuration: number): number {
    if (entry?.durationSec != null) return entry.durationSec;
    return Number.isFinite(audioDuration) && audioDuration > 0 ? audioDuration : 0;
  }

  private logicalItemDuration(audioDuration: number): number {
    let duration = this.itemElapsed + this.entryDuration(this.activeEntry, audioDuration);
    if (this.activeEntry?.completesItem) return duration;
    for (const entry of this.queue) {
      duration += entry.durationSec ?? 0;
      if (entry.completesItem) break;
    }
    return duration;
  }

  private cleanupBlobUrls(): void {
    for (const url of this.blobUrls) {
      URL.revokeObjectURL(url);
    }
    this.blobUrls = [];
  }
}
