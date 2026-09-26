/**
 * External runtime — what the inventory is told about a supervised runtime's state.
 *
 * WHY ITS OWN UNIT (seventh-round review P1-B, sol): every write of `runtimeState` must first
 * re-check that the authority the write was decided under still holds, or a stale supervisor can
 * stamp state onto an instance that was reinstalled, disabled or re-granted underneath it. That
 * check is the whole content of these two functions, and it is the same authority question
 * `runtime-crash-projection.ts` answers for the crash path — so the two live side by side rather
 * than inside the lifecycle orchestration.
 */

import type { PluginInventoryTransaction } from '../host-inventory/ports.js';
import type { RuntimeState } from '../host-inventory/types.js';
import { projectRuntimeCrash } from './runtime-crash-projection.js';
import type { RuntimeExecution } from './runtime-execution.js';
import type { ExternalPluginRuntimeSupervisorOptions } from './types.js';
import { ExternalPluginRuntimeError } from './types.js';

export interface RuntimeProjectionDeps {
  readonly inventory: ExternalPluginRuntimeSupervisorOptions['inventory'];
  readonly now: () => number;
}

/** Writes `runtimeState`, refusing when the authority the write was decided under has moved. */
export async function setRuntimeState(
  deps: RuntimeProjectionDeps,
  execution: RuntimeExecution,
  runtimeState: RuntimeState,
): Promise<void> {
  await deps.inventory.transaction((transaction: PluginInventoryTransaction) => {
    const instance = transaction.instances.get(execution.pluginInstanceId);
    if (
      !instance ||
      instance.lifecycleState !== 'installed' ||
      instance.packageDigest !== execution.packageDigest ||
      instance.configReadiness !== 'ready' ||
      instance.activationState !== 'enabled'
    ) {
      throw new ExternalPluginRuntimeError(
        'INSTANCE_NOT_RUNNABLE',
        `${execution.pluginInstanceId} authority changed before runtime projection`,
      );
    }
    if (runtimeState === 'starting') {
      const { lastRuntimeError: _lastRuntimeError, ...withoutRuntimeError } = instance;
      transaction.instances.put({ ...withoutRuntimeError, runtimeState, updatedAt: deps.now() });
    } else {
      transaction.instances.put({ ...instance, runtimeState, updatedAt: deps.now() });
    }
  });
}

/** Projects the end of an execution: crash diagnostics, or a plain return to `stopped`. */
export async function projectTerminalState(
  deps: RuntimeProjectionDeps,
  execution: RuntimeExecution,
  terminalState: 'stopped' | 'crashed' | 'restartable',
): Promise<void> {
  if (execution.projected && (terminalState === 'crashed' || terminalState === 'restartable')) {
    await projectRuntimeCrash(deps.inventory, execution, deps.now, {
      preserveActivation: terminalState === 'restartable',
      suppressExitDiagnostic: terminalState === 'restartable',
    }).catch(() => undefined);
    return;
  }
  if (execution.projected && !execution.connection) {
    await setRuntimeState(deps, execution, 'stopped').catch(() => undefined);
  }
}
