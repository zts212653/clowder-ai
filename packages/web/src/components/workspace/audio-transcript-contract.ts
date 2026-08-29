export interface TranscriptLine {
  ts: number;
  elapsed_s: number;
  chunk_num: number;
  asr_latency: number;
  text: string;
  speaker_label?: string;
  speaker_confidence?: number;
  speaker_id?: string | null;
  speaker_identity_source?: string;
  speaker_cluster_id?: string | null;
  input_id?: string;
  input_source?: 'app' | 'mic';
  input_label?: string;
}

export interface Participant {
  id: string;
  name: string;
  role?: string;
}

export interface AudioAppSource {
  id: string;
  name: string;
}

export interface AudioSources {
  apps: AudioAppSource[];
  mics: { index: number; name: string; default: boolean }[];
}

export interface AudioInputRequest {
  id: string;
  source: 'app' | 'mic';
  app_name?: string;
  device?: number;
  label?: string;
}

export interface AudioInputStatus extends AudioInputRequest {
  state?: 'starting' | 'running' | 'failed' | 'stopped';
  reason?: string | null;
  chunk_count?: number;
  deduplicated_chunks?: number;
}

export interface ComponentHealth {
  state: 'unknown' | 'ready' | 'degraded' | 'error';
  reason?: string;
  model?: string;
}

export interface AudioStatus {
  running: boolean;
  paused?: boolean;
  source?: string;
  app_name?: string;
  duration_s?: number;
  chunk_count?: number;
  avg_asr_latency?: number;
  participants?: Participant[];
  clusters?: { id: string; display_name: string; count: number }[];
  cluster_diagnostics?: {
    confirmed: number;
    provisional: number;
    max_clusters: number;
    confirmations_required: number;
    birth_threshold: number;
    assignment_threshold: number;
    replacements: number;
  };
  inputs?: AudioInputStatus[];
  health?: {
    asr?: ComponentHealth;
    speaker_separation?: ComponentHealth;
  };
}

export interface AudioSseEvent extends Partial<TranscriptLine> {
  type: string;
  status?: string;
  source?: string;
  app_name?: string;
  inputs?: AudioInputStatus[];
  health?: AudioStatus['health'];
  transcript_path?: string;
  recording_path?: string;
  recording_paths?: Record<string, string>;
  reason?: string;
  confidence?: number;
  source_chunk_num?: number;
  source_text?: string;
  talking_point?: string | null;
}
