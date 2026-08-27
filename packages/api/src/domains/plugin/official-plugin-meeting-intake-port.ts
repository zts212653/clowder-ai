import type { PluginInstanceRecord } from './host-inventory/types.js';
import type { OfficialPluginCatalogEntry } from './official-catalog.js';

export type OfficialMeetingCatchUpProjection =
  | { readonly status: 'idle' }
  | {
      readonly status: 'needs-owner';
      readonly fromCursor: string | null;
      readonly throughCursor: string;
      readonly detectedAt: number;
    }
  | {
      readonly status: 'previewed';
      readonly fromCursor: string | null;
      readonly throughCursor: string;
      readonly candidateCount: number;
      readonly fingerprint: string;
      readonly previewedAt: number;
    }
  | {
      readonly status: 'backlog';
      readonly fromCursor: string | null;
      readonly throughCursor: string;
      readonly candidateCountAtLeast: number;
      readonly reason: 'PAGE_BOUND' | 'CANDIDATE_BOUND';
      readonly detectedAt: number;
    };

export interface OfficialMeetingIntakeWarning {
  readonly code:
    | 'OBSERVATION_UNKNOWN'
    | 'OBSERVATION_STALE'
    | 'PUBLISH_PENDING'
    | 'CATCH_UP_REQUIRED'
    | 'CATCH_UP_BACKLOG';
  readonly message: string;
  readonly action: 'preview-catch-up' | 'resolve-catch-up' | 'repair' | 'needs-owner';
}

export interface OfficialMeetingIntakeProjection {
  readonly status: 'ready' | 'auth-expired' | 'degraded';
  readonly code?: string;
  readonly lastCycleAt: number | null;
  readonly lastSuccessfulObservationAt: number | null;
  readonly lastPublishedAt: number | null;
  readonly pendingCount: number;
  readonly catchUp: OfficialMeetingCatchUpProjection;
  readonly warning?: OfficialMeetingIntakeWarning;
}

export interface OfficialMeetingCatchUpPreview {
  readonly fromCursor: string | null;
  readonly throughCursor: string;
  readonly candidateCount: number;
  readonly fingerprint: string;
}

export interface OfficialPluginMeetingIntakePort {
  project(
    entry: OfficialPluginCatalogEntry,
    instance: PluginInstanceRecord,
  ): Promise<OfficialMeetingIntakeProjection | undefined>;
  detect(
    entry: OfficialPluginCatalogEntry,
    instance: PluginInstanceRecord,
  ): Promise<OfficialMeetingCatchUpProjection | undefined>;
  preview(entry: OfficialPluginCatalogEntry, instance: PluginInstanceRecord): Promise<OfficialMeetingCatchUpPreview>;
  resolve(
    entry: OfficialPluginCatalogEntry,
    instance: PluginInstanceRecord,
    decision: { readonly action: 'future-only' | 'replay'; readonly fingerprint: string },
  ): Promise<{ readonly action: 'future-only' | 'replay'; readonly candidateCount: number }>;
}

export class OfficialMeetingIntakeError extends Error {
  constructor(
    readonly code: 'CATCH_UP_BACKLOG' | 'CATCH_UP_PREVIEW_CHANGED',
    message: string,
  ) {
    super(message);
    this.name = 'OfficialMeetingIntakeError';
  }
}
