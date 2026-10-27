import { createModuleLogger } from '../../../infrastructure/logger.js';
import { MessagingError } from '../../messaging/contract/host-types.js';
import { type PackageStagingPhase, packageStagingPhase } from '../external-runtime/package-staging-diagnostics.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { PluginInventoryError, type PluginRuntimeErrorRecord } from '../host-inventory/types.js';
import { ManifestConfigurationProjectionError } from '../manifest-configuration-projection.js';
import { type HostErrorRecognition, type SafeErrorProjection, safeErrorProjection } from './safe-error-projection.js';

/** F202 W2-6b — where a runtime start was attempted when it failed. */
export type PluginStartPhase =
  | 'enable'
  | 'repair'
  | 'restart_resume'
  | 'maintenance_resume'
  | 'maintenance_rollback_resume';

/** What the Host can vouch for about a failed start; anything else stays unclassified. */
export type PluginStartFailureCategory =
  | { readonly kind: 'host_runtime_error'; readonly code: string }
  | { readonly kind: 'unclassified' };

/** A failed start as the Host log receives it: never the raw error, only its safe projection. */
export interface PluginStartFailureReport {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly phase: PluginStartPhase;
  /** Also the `occurredAt` of the failure recorded on the instance, so the two can be matched. */
  readonly occurredAt: number;
  readonly category: PluginStartFailureCategory;
  readonly error: SafeErrorProjection;
  /** Closed Host-only phase; absent for errors outside verified archive staging. */
  readonly stagingPhase?: PackageStagingPhase;
}

export type PluginStartFailureObserver = (report: PluginStartFailureReport) => void;

const HOST_CODE = /^[A-Za-z][A-Za-z_]{0,47}$/u;

/** The closed-set code of an error the Host's own code raised; the text around it is never kept. */
function hostErrorCode(error: unknown): string | undefined {
  try {
    const code =
      error instanceof ExternalPluginRuntimeError ||
      error instanceof MessagingError ||
      error instanceof PluginInventoryError
        ? error.code
        : error instanceof ManifestConfigurationProjectionError
          ? error.failure.reason
          : undefined;
    return typeof code === 'string' && HOST_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

const HOST_RECOGNITION: HostErrorRecognition = { hostCode: hostErrorCode };

function hostRuntimeErrorCode(error: unknown): string | undefined {
  try {
    return error instanceof ExternalPluginRuntimeError ? hostErrorCode(error) : undefined;
  } catch {
    return undefined;
  }
}

export function classifyStartFailure(error: unknown): PluginStartFailureCategory {
  const code = hostRuntimeErrorCode(error);
  return code === undefined ? { kind: 'unclassified' } : { kind: 'host_runtime_error', code };
}

export function pluginStartFailureReport(input: {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly phase: PluginStartPhase;
  readonly occurredAt: number;
  readonly error: unknown;
}): PluginStartFailureReport {
  const stagingPhase = packageStagingPhase(input.error);
  return {
    pluginId: input.pluginId,
    pluginInstanceId: input.pluginInstanceId,
    phase: input.phase,
    occurredAt: input.occurredAt,
    category: classifyStartFailure(input.error),
    error: safeErrorProjection(input.error, HOST_RECOGNITION),
    ...(stagingPhase ? { stagingPhase } : {}),
  };
}

const log = createModuleLogger('plugin/lifecycle');

/** The Host's default observer: one error line per failed start in the server log. */
export function logPluginStartFailure(report: PluginStartFailureReport): void {
  log.error({ ...report }, 'plugin runtime failed to start');
}

/** Records a runtime start failure without retaining plugin-provided text. */
export function startFailureRecord(occurredAt: number): {
  readonly record: PluginRuntimeErrorRecord;
} {
  return { record: { code: 'UNEXPECTED_RUNTIME_FAILURE', exitCode: null, signal: null, occurredAt } };
}
