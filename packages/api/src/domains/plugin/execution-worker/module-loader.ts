import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { type ModuleExecutionLease, ModuleExecutionWorker } from './client.js';

export interface LoadedExecutionDefinition<Definition> {
  readonly definition: Definition;
  readonly lease: ModuleExecutionLease;
}

export async function loadExecutionDefinition<Definition>(
  worker: ModuleExecutionWorker,
  instanceId: string,
  entrypoint: string,
  manifest: PluginManifest,
): Promise<LoadedExecutionDefinition<Definition>> {
  const lease = await worker.lease(instanceId);
  try {
    const definition = await lease.call<Definition>('definition', entrypoint, manifest);
    return { lease, definition };
  } catch (error) {
    await lease.close();
    throw error;
  }
}
