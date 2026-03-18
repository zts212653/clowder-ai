import type { VoiceChunkEvent, VoiceStreamEndEvent, VoiceStreamStartEvent } from '@cat-cafe/shared';

export type PlaybackManagerState = 'idle' | 'playing' | 'paused';

export interface PlaybackManagerCallbacks {
  onStateChange: (state: PlaybackManagerState) => void;
  /** Called each time a queued item finishes, with the 0-based index of the completed item within a batch. */
  onItemEnd?: (index: number) => void;
}

let domAudio: HTMLAudioElement | null = null;

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
  private queue: string[] = [];
  private blobUrls: string[] = [];
  private state: PlaybackManagerState = 'idle';
  private activeInvocationId: string | null = null;
  private streamDone = false;
  private firstChunkPlayed = false;
  private callbacks: PlaybackManagerCallbacks;
  /** Track completed items within a batch (for podcast progress tracking). */
  private batchItemIndex = 0;
  private batchMode = false;
  /** Monotonically increasing ID to invalidate in-flight fetches after interrupt/new batch. */
  private batchId = 0;

  constructor(callbacks: PlaybackManagerCallbacks) {
    this.callbacks = callbacks;
  }

  handleStreamStart(event: VoiceStreamStartEvent): void {
    if (this.activeInvocationId && this.activeInvocationId !== event.invocationId) {
      this.interrupt();
    }
    this.activeInvocationId = event.invocationId;
    this.streamDone = false;
    this.firstChunkPlayed = false;
    this.batchMode = false;
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
      this.playUrl(blobUrl);
    } else if (this.state === 'idle') {
      this.playUrl(blobUrl);
    } else {
      this.queue.push(blobUrl);
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
   * The returned promise resolves when the URL is fetched and enqueued (not when playback finishes).
   * @param fetchFn - Fetch function that returns a Response (allows passing auth-aware fetchers like apiFetch).
   */
  async enqueueUrl(url: string, fetchFn: (url: string) => Promise<Response> = fetch): Promise<void> {
    const capturedBatchId = this.batchId;
    let res: Response;
    try {
      res = await fetchFn(url);
    } catch (err) {
      console.error('[PlaybackManager] enqueueUrl fetch rejected:', err);
      return;
    }
    if (this.batchId !== capturedBatchId) return;
    if (!res.ok) {
      console.error(`[PlaybackManager] enqueueUrl fetch failed: ${res.status}`);
      return;
    }
    let blob: Blob;
    try {
      blob = await res.blob();
    } catch (err) {
      console.error('[PlaybackManager] enqueueUrl blob() rejected:', err);
      return;
    }
    if (this.batchId !== capturedBatchId) return;
    const blobUrl = URL.createObjectURL(blob);
    this.blobUrls.push(blobUrl);

    const audio = getDomAudio();
    if (this.state === 'idle' || (this.state === 'playing' && audio.ended)) {
      this.playUrl(blobUrl);
    } else {
      this.queue.push(blobUrl);
    }
  }

  /**
   * Start a batch playback session (e.g. podcast "play all").
   * Interrupts any ongoing playback, enters batch mode, then enqueues URLs sequentially.
   * @param urls - Audio URLs to play in order.
   * @param fetchFn - Auth-aware fetch function.
   * @returns A promise that resolves when all URLs are enqueued (playback may still be ongoing).
   */
  async startBatch(urls: string[], fetchFn: (url: string) => Promise<Response> = fetch): Promise<void> {
    this.interrupt();
    this.batchId++;
    const capturedBatchId = this.batchId;
    this.batchMode = true;
    this.batchItemIndex = 0;
    this.streamDone = false;
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

  /** Whether a batch playback is currently active. */
  isBatchActive(): boolean {
    return this.batchMode && this.state !== 'idle';
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
    this.setState('idle');
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

  private playUrl(url: string): void {
    const audio = getDomAudio();
    audio.src = url;
    audio.onended = () => {
      if (this.batchMode) {
        this.callbacks.onItemEnd?.(this.batchItemIndex);
        this.batchItemIndex++;
      }
      this.playNext();
    };
    audio.onerror = () => {
      console.error('[PlaybackManager] Audio playback error');
      if (this.batchMode) {
        this.batchItemIndex++;
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
      this.playUrl(next);
    } else if (this.streamDone) {
      if (this.batchMode) {
        this.batchMode = false;
        this.batchItemIndex = 0;
      }
      this.setState('idle');
    }
  }

  private setState(newState: PlaybackManagerState): void {
    if (this.state === newState) return;
    this.state = newState;
    this.callbacks.onStateChange(newState);
  }

  private cleanupBlobUrls(): void {
    for (const url of this.blobUrls) {
      URL.revokeObjectURL(url);
    }
    this.blobUrls = [];
  }
}
