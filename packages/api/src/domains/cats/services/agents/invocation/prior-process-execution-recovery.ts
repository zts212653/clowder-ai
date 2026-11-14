/**
 * The startup recovery of executions a prior API process left, in its one required order. index.ts
 * runs it after the listener is owned; the #1838 two-host restart test runs the same function, so
 * the order the test proves is the order the product runs.
 *
 *   1. callback auth reconciles its own projection;
 *   2. the external owner snapshot decides which prior executions are still owned;
 *   3. a verifiably closed Windows API job writes teardown proof for the executions it owned;
 *   4. the TurnExecution reconciler interrupts unowned children and settles their responses;
 *   5. the StartupReconciler settles parent invocations, queue and history;
 *   6. Windows job evidence is cleared only after settlement, so a failed pass keeps it.
 */

import type { CliExecutionOwnerSnapshot } from '../../../../../utils/cli-process-ownership.js';
import type { TurnExecutionRecord } from '../../stores/ports/TurnExecutionStore.js';
import type { CallbackAuthTurnExecutionLifecycle } from './CallbackAuthTurnExecutionLifecycle.js';
import { StartupReconciler, type StartupReconcilerDeps } from './StartupReconciler.js';
import { TurnExecutionStartupReconciler } from './TurnExecutionStartupReconciler.js';
import { clearSettledWindowsJobEvidence, recordVerifiedWindowsJobTeardowns } from './WindowsJobStopRecovery.js';

export async function recoverPriorProcessExecutions(deps: {
  processStartedAt: number;
  turnExecutionStore: CallbackAuthTurnExecutionLifecycle;
  listLiveExecutionOwners: () => Promise<CliExecutionOwnerSnapshot>;
  settleEndedTurnResponse: (turn: TurnExecutionRecord) => Promise<unknown>;
  /** Where the Windows job owner records and execution links live. */
  windowsJobDataDir?: string;
  orphans: Omit<StartupReconcilerDeps, 'turnExecutionStore' | 'processStartAt'>;
  markStartupRecoveryComplete: () => void;
}) {
  const store = deps.turnExecutionStore;
  const processStartedAt = deps.processStartedAt;
  const authRecovery = await store.reconcileStartup({ processStartedAt });
  const liveExecutionOwners = await deps.listLiveExecutionOwners();
  const windowsJobTeardowns = await recordVerifiedWindowsJobTeardowns({
    store,
    dataDir: deps.windowsJobDataDir,
  });
  const childReconciler = new TurnExecutionStartupReconciler({
    store,
    settleEndedTurnResponse: deps.settleEndedTurnResponse,
  });
  // #1838: a Windows provider whose host job is still present, or whose exact controller API is
  // still alive, has a live owner as surely as a listed CLI owner; it joins the same exclusion.
  const childRecovery =
    liveExecutionOwners.complete && windowsJobTeardowns.liveOwnersComplete
      ? await childReconciler.reconcile({
          processStartedAt,
          protectedInvocationIds: [
            ...liveExecutionOwners.owners.map((owner) => owner.invocationId),
            ...windowsJobTeardowns.liveOwners,
          ],
        })
      : {
          interruptedCount: 0,
          invocationIds: [],
          // Ended turns have no owner left to wait for; running ones keep their unknown owners.
          ...(await childReconciler.settleEndedTurnResponses({ processStartedAt })),
          reconciledAt: Date.now(),
          skippedReason: 'cli_execution_owner_snapshot_incomplete',
        };
  const startupRecovery = await new StartupReconciler({
    ...deps.orphans,
    turnExecutionStore: store,
    processStartAt: processStartedAt,
  }).reconcileOrphans();
  deps.markStartupRecoveryComplete();
  const windowsJobEvidence = await clearSettledWindowsJobEvidence({ store, pass: windowsJobTeardowns }).catch(
    (error: unknown) => ({ clearFailed: String(error) }),
  );
  return {
    authRecovery,
    liveOwnersComplete: liveExecutionOwners.complete,
    childRecovery,
    startupRecovery,
    windowsJobTeardowns,
    windowsJobEvidence,
  };
}
