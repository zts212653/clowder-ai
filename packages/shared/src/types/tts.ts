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

/** TTS synthesis request (passed to ITtsProvider) */
export interface TtsSynthesizeRequest {
  readonly text: string;
  readonly voice: string;
  readonly langCode?: string;
  readonly speed?: number;
  readonly format?: 'wav' | 'mp3';
  // F066: Qwen3-TTS Base clone mode fields
  readonly refAudio?: string;
  readonly refText?: string;
  readonly instruct?: string;
  readonly temperature?: number;
}

/** TTS synthesis result (returned by ITtsProvider) */
export interface TtsSynthesizeResult {
  readonly audio: Uint8Array;
  readonly format: string;
  readonly durationSec?: number;
  readonly metadata: {
    readonly provider: string;
    readonly model: string;
    readonly voice: string;
  };
}

/** Interface that all TTS providers must implement */
export interface ITtsProvider {
  readonly id: string;
  /** Model identifier — included in cache key to avoid stale hits across model swaps */
  readonly model: string;
  synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult>;
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
}

// F111 Phase B + F112 Phase A: Real-time voice stream events (WebSocket)
// These events are pushed from route-serial via socketManager during token streaming,
// enabling "边吐字边转语音" — TTS synthesis parallel with LLM token generation.

/** Sent when a cat starts generating voice for an invocation */
export interface VoiceStreamStartEvent {
  readonly type: 'voice_stream_start';
  readonly catId: string;
  readonly invocationId: string;
  readonly threadId: string;
}

/** Sent for each synthesized audio chunk (one per sentence) */
export interface VoiceChunkEvent {
  readonly type: 'voice_chunk';
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
  readonly type: 'voice_stream_end';
  readonly catId: string;
  readonly invocationId: string;
  readonly threadId: string;
  readonly totalChunks: number;
}

/** Union of all voice stream WebSocket events */
export type VoiceStreamEvent = VoiceStreamStartEvent | VoiceChunkEvent | VoiceStreamEndEvent;
