/**
 * F34: TTS (Text-to-Speech) Types
 *
 * Provider-agnostic types for the TTS subsystem.
 * Audio uses Uint8Array (not Buffer) to stay runtime-neutral — usable in both
 * Node.js and browser contexts without pulling in Node-specific types.
 */

/** Per-cat TTS voice configuration */
export interface VoiceConfig {
  readonly voice: string; // provider-specific voice ID (e.g. 'zm_yunxi')
  readonly langCode: string; // 'z' for Chinese, 'en-us' for English
  readonly speed?: number; // playback speed multiplier (default 1.0)
  // F066: Qwen3-TTS Base clone mode fields
  readonly refAudio?: string; // path to reference audio file for voice cloning
  readonly refText?: string; // transcript of the reference audio
  readonly instruct?: string; // style/emotion instruction for Qwen3 clone
  readonly temperature?: number; // generation temperature (0.3 recommended for consistency)
}

/** Read-side provenance; this is never a second saved voice configuration. */
export interface CatVoiceResolution {
  readonly catId: string;
  readonly source: 'cat_config' | 'breed_default' | 'global_default' | 'unknown';
  readonly breedId?: string;
  readonly envOverride?: string;
  readonly config: VoiceConfig;
}

export interface CatVoiceOption {
  readonly id: string;
  readonly label: string;
  readonly familyId: string;
  readonly familyName: string;
  readonly sourceCatId: string;
  readonly voiceConfig: VoiceConfig;
  readonly available: boolean;
  readonly referenceAvailability?: 'unknown';
}

/** Parameters used for this asset, including explicit fallback/uncertainty. */
export interface TtsVoiceSelection extends Omit<CatVoiceResolution, 'config'> {
  readonly provider: string;
  readonly model: string;
  readonly requested: VoiceConfig;
  readonly effective: VoiceConfig;
  readonly referenceStatus:
    | 'sent'
    | 'verified_cache'
    | 'missing'
    | 'unavailable'
    | 'unsupported'
    | 'unverified'
    | 'not_requested';
  readonly warnings: readonly string[];
  readonly referenceSha256?: string;
  readonly referenceInputSha256?: string;
  readonly referenceTransport?: 'inline' | 'provider_path';
}

export interface TtsReferenceReceipt {
  readonly status: 'used' | 'unavailable' | 'unverified';
  readonly sha256?: string;
}

/** TTS synthesis request (passed to ITtsProvider) */
export interface TtsSynthesizeRequest {
  readonly text: string;
  readonly voice: string;
  readonly langCode?: string;
  readonly speed?: number;
  readonly format?: 'wav' | 'mp3';
  // F066: Qwen3-TTS Base clone mode fields
  readonly refAudio?: string;
  /** Captured authorized bytes; only sent to a reader advertising content-v1. */
  readonly refAudioData?: { readonly base64: string; readonly sha256: string };
  readonly refText?: string;
  readonly instruct?: string;
  readonly temperature?: number;
}

/** TTS synthesis result (returned by ITtsProvider) */
export interface TtsSynthesizeResult {
  readonly audio: Uint8Array;
  readonly format: string;
  readonly durationSec?: number;
  readonly referenceAudio?: TtsReferenceReceipt;
  readonly metadata: {
    readonly provider: string;
    readonly model: string;
    readonly voice: string;
  };
}

export type TtsSynthesizeStreamEvent =
  | {
      readonly type: 'chunk';
      readonly audio: Uint8Array;
      readonly format: string;
      readonly durationSec?: number;
      readonly isFinalChunk: boolean;
      readonly referenceAudio?: TtsReferenceReceipt;
      readonly voiceSelection?: TtsVoiceSelection;
    }
  | {
      readonly type: 'final';
      readonly result: TtsSynthesizeResult;
    };

export interface TtsSynthesizeStreamOptions {
  /** Cancels work that no longer has a playback consumer. */
  readonly signal?: AbortSignal;
  /** Observe native audio before the provider normalizes the final-chunk marker. */
  readonly onEarlyChunk?: (chunk: Extract<TtsSynthesizeStreamEvent, { type: 'chunk' }>) => void;
}

/** Interface that all TTS providers must implement */
export interface ITtsProvider {
  readonly id: string;
  /** Model identifier — included in cache key to avoid stale hits across model swaps */
  readonly model: string;
  /** Frozen from the actual adapter, never guessed from a model name. */
  readonly referenceAudioSupport?: boolean;
  readonly referenceAudioContentSupport?: boolean;
  /** False when this adapter ignores preset IDs (e.g. Base reference-only generation). */
  readonly voiceIdSupport?: boolean;
  /** Offline snapshots may only reuse verified local assets. */
  readonly cacheOnly?: boolean;
  /** Frozen endpoint and generation identity for content-addressed audio. */
  readonly cacheIdentity?: string;
  /** Freeze identity for cache lookup and multi-part synthesis; cacheDir may permit verified cache-only replay. */
  snapshot?(options?: { readonly cacheDir?: string }): Promise<ITtsProvider>;
  synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult>;
  /** Native model streaming when supported; final carries the complete cacheable asset. */
  stream?(request: TtsSynthesizeRequest, options?: TtsSynthesizeStreamOptions): AsyncIterable<TtsSynthesizeStreamEvent>;
}

// F111: Streaming TTS types
export interface TtsStreamRequest {
  readonly text: string;
  readonly catId?: string;
  readonly voice?: string;
  readonly langCode?: string;
  readonly speed?: number;
}

export interface TtsStreamEvent {
  readonly type: 'chunk' | 'done' | 'error';
  readonly index?: number;
  readonly total?: number;
  readonly sourceIndex?: number;
  readonly sourceTotal?: number;
  readonly audioBase64?: string;
  readonly text?: string;
  readonly durationSec?: number;
  readonly format?: string;
  readonly error?: string;
  readonly voiceSelection?: TtsVoiceSelection;
}

// F111 Phase B + F112 Phase A: Real-time voice stream events (WebSocket)
// These events are pushed from route-serial via socketManager during token streaming,
// enabling "边吐字边转语音" — TTS synthesis parallel with LLM token generation.

/** Sent when a cat starts generating voice for an invocation */
export interface VoiceStreamStartEvent {
  readonly voiceSelection?: TtsVoiceSelection;
  readonly type: 'voice_stream_start';
  readonly catId: string;
  readonly invocationId: string;
  readonly threadId: string;
}

/** Sent for each synthesized audio chunk (one per sentence) */
export interface VoiceChunkEvent {
  readonly type: 'voice_chunk';
  readonly voiceSelection?: TtsVoiceSelection;
  readonly catId: string;
  readonly invocationId: string;
  readonly threadId: string;
  readonly index: number;
  readonly audioBase64: string;
  readonly text: string;
  readonly format: string;
  readonly durationSec?: number;
}

/** Sent when the voice stream for an invocation ends. totalChunks=-1 means aborted. */
export interface VoiceStreamEndEvent {
  readonly voiceSelection?: TtsVoiceSelection;
  readonly type: 'voice_stream_end';
  readonly catId: string;
  readonly invocationId: string;
  readonly threadId: string;
  readonly totalChunks: number;
}

/** Union of all voice stream WebSocket events */
export type VoiceStreamEvent = VoiceStreamStartEvent | VoiceChunkEvent | VoiceStreamEndEvent;
