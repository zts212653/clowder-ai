/**
 * F088 Phase 6: STT (Speech-to-Text) Types
 * Mirrors ITtsProvider pattern for speech recognition.
 */

export interface SttTranscribeRequest {
  readonly audioPath: string;
  readonly signal?: AbortSignal;
  readonly language?: string;
  readonly format?: string;
}

export interface SttTranscribeResult {
  readonly text: string;
  readonly language?: string;
  readonly durationSec?: number;
  readonly metadata: {
    readonly provider: string;
    readonly model: string;
  };
}

export interface ISttProvider {
  readonly id: string;
  readonly model: string;
  transcribe(request: SttTranscribeRequest): Promise<SttTranscribeResult>;
}
