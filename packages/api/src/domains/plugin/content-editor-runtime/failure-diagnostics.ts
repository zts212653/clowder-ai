import { createModuleLogger } from '../../../infrastructure/logger.js';
import { workMs } from '../diagnostics/observation-work.js';
import { type SafeErrorProjection, safeErrorProjection } from '../diagnostics/safe-error-projection.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { HostBrokerError } from '../host-broker/types.js';

type HeartbeatStage = 'package-verification' | 'lease-renew';

interface StageResult {
  readonly stage: HeartbeatStage;
  readonly elapsedMs: number;
  readonly status: 'ok' | 'failed';
}

export interface EditorFailureObservation {
  readonly phase: 'heartbeat' | 'surface';
  readonly timerLagMs?: number;
  readonly failedStage?: HeartbeatStage;
  readonly stages?: readonly StageResult[];
  readonly error?: SafeErrorProjection;
}

export interface EditorRuntimeFailureReport extends EditorFailureObservation {
  readonly pluginInstanceId: string;
  readonly lifecycleRevision: number;
  /** Matches the durable inventory failure, so a later projection cannot invent a new occurrence. */
  readonly occurredAt: number;
}

/** One heartbeat, two fixed stages; only its terminal failure is logged. */
export class EditorHeartbeatDiagnostics {
  private readonly stages: StageResult[] = [];

  constructor(private readonly timerLagMs: number) {}

  async measure<T>(stage: HeartbeatStage, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      const result = await operation();
      this.stages.push({ stage, elapsedMs: workMs(performance.now() - started), status: 'ok' });
      return result;
    } catch (error) {
      this.stages.push({ stage, elapsedMs: workMs(performance.now() - started), status: 'failed' });
      throw error;
    }
  }

  failure(error: unknown): EditorFailureObservation {
    return {
      phase: 'heartbeat',
      timerLagMs: workMs(this.timerLagMs),
      failedStage: this.stages.at(-1)?.stage,
      stages: [...this.stages],
      // Reuse the Host's defensive bounded projection; never retain exception messages or raw stacks.
      error: safeErrorProjection(error, {
        hostCode: (value) =>
          value instanceof HostBrokerError || value instanceof ExternalPluginRuntimeError ? value.code : undefined,
      }),
    };
  }
}

const log = createModuleLogger('plugin/editor-runtime');

export function logEditorRuntimeFailure(report: EditorRuntimeFailureReport): void {
  log.error({ ...report }, 'content editor runtime lost');
}
