export interface OfficialPluginInstance {
  pluginInstanceId: string;
  installedVersion: string | null;
  packageDigest: string;
  lifecycleState: 'installed' | 'retired';
  configReadiness: 'incomplete' | 'ready';
  activationState: 'disabled' | 'enabling' | 'enabled' | 'disabling' | 'error';
  runtimeState: 'stopped' | 'starting' | 'handshaking' | 'healthy' | 'degraded' | 'crashed';
  lifecycleRevision: number;
  installedAt: number;
  updatedAt: number;
  lastRuntimeError?: {
    code: string;
    exitCode: number | null;
    signal: string | null;
    occurredAt: number;
  };
}

export interface OfficialPluginInfo {
  catalogId: string;
  packageName: string;
  version: string;
  availableVersion: string;
  pluginId: string;
  packageDigest: string;
  effectiveGrants: string[];
  ownerAuthAvailable: boolean;
  updateAvailable: boolean;
  instance: OfficialPluginInstance | null;
  intakeHealth?: OfficialMeetingIntakeHealth;
}

export interface OfficialMeetingIntakeHealth {
  status: 'ready' | 'auth-expired' | 'degraded';
  code?: string;
  lastCycleAt: number | null;
  lastSuccessfulObservationAt: number | null;
  lastPublishedAt: number | null;
  pendingCount: number;
  catchUp:
    | { status: 'idle' }
    | { status: 'needs-owner'; fromCursor: string | null; throughCursor: string; detectedAt: number }
    | {
        status: 'previewed';
        fromCursor: string | null;
        throughCursor: string;
        candidateCount: number;
        fingerprint: string;
        previewedAt: number;
      }
    | {
        status: 'backlog';
        fromCursor: string | null;
        throughCursor: string;
        candidateCountAtLeast: number;
        reason: 'PAGE_BOUND' | 'CANDIDATE_BOUND';
        detectedAt: number;
      };
  warning?: {
    code: string;
    message: string;
    action: 'preview-catch-up' | 'resolve-catch-up' | 'repair' | 'needs-owner';
  };
}

export type OfficialPluginAction = 'install' | 'update' | 'enable' | 'disable' | 'repair' | 'uninstall';
