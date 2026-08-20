import type { BrokerConnection } from '../host-broker/builtin-loopback.js';
import type { ExternalPluginProcess, VerifiedPluginPackage } from './types.js';

export interface RuntimeExecutionResources {
  readonly process?: ExternalPluginProcess;
  exit?: Awaited<ExternalPluginProcess['exited']>;
  readonly locatedPackage?: VerifiedPluginPackage;
  readonly connection?: BrokerConnection;
}

export async function closeRuntimeExecutionResources(
  execution: RuntimeExecutionResources,
  reason: string,
  terminateProcess: boolean,
): Promise<void> {
  if (execution.connection) await execution.connection.close(reason).catch(() => undefined);
  if (terminateProcess && execution.process) await execution.process.terminate().catch(() => undefined);
  if (execution.process && execution.exit === undefined) {
    execution.exit = await execution.process.exited.catch(() => undefined);
  }
  if (execution.locatedPackage) await execution.locatedPackage.release().catch(() => undefined);
}
