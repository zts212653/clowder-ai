/**
 * MediaHub — Core Types
 * F139: AI Media Generation Gateway
 */

/** Supported media generation capabilities */
export type MediaCapability = 'text2video' | 'image2video' | 'text2image' | 'image2image';

/** Job lifecycle states */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout';

/** Authentication mode for a provider */
export type AuthMode = 'none' | 'api_key' | 'session_bridge';

/** Provider metadata exposed to consumers */
export interface ProviderInfo {
  id: string;
  displayName: string;
  capabilities: readonly MediaCapability[];
  authMode: AuthMode;
  models: readonly string[];
  /** Provider-specific notes (e.g. "Free unlimited", "66 credits/day") */
  notes?: string;
}

/** Input for a media generation request */
export interface GenerationRequest {
  providerId: string;
  model?: string;
  capability: MediaCapability;
  prompt: string;
  /** Reference image URL or base64 for image2video / image2image */
  imageUrl?: string;
  /** Video duration in seconds (provider-dependent) */
  duration?: number;
  /** Aspect ratio e.g. "16:9", "9:16", "1:1" */
  aspectRatio?: string;
  /** Negative prompt */
  negativePrompt?: string;
}

/** Persisted job record */
export interface JobRecord {
  jobId: string;
  providerId: string;
  providerTaskId?: string;
  capability: MediaCapability;
  model: string;
  prompt: string;
  status: JobStatus;
  /** Local file path of completed media */
  outputPath?: string;
  /** Original provider result URL (may expire) */
  providerResultUrl?: string;
  /** Error message if failed */
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/** Result of a generation submission */
export interface SubmitResult {
  jobId: string;
  providerTaskId?: string;
  status: JobStatus;
}

/** Result of a status query */
export interface StatusResult {
  jobId: string;
  status: JobStatus;
  /** Progress 0-100 if available */
  progress?: number;
  outputPath?: string;
  providerResultUrl?: string;
  error?: string;
}
