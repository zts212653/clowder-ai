/**
 * External runtime — start authority: what a child process is allowed to start with.
 *
 * WHY THIS IS ITS OWN UNIT (seventh-round review P1-B, sol):
 * Three questions share one subject and must not drift apart:
 *   1. may this instance run at all (`resolveRunnableAuthority`);
 *   2. is the authority the start decision read still mine (`assertAuthorityUnchanged`);
 *   3. which declared configuration may actually cross into the child's environment
 *      (`projectStartConfiguration`).
 * The supervisor orchestrates a process lifecycle; it is not the place to also own the answer to
 * "what authority is this". Keeping them here means a future change to the fence or the projection
 * has exactly one home, and the supervisor stays under the file-size cap while doing so.
 */

import type {
  PluginGrantRecord,
  PluginInstanceRecord,
  PluginPackageRecord,
  RuntimeState,
} from '../host-inventory/types.js';
import {
  ManifestConfigurationProjectionError,
  type PluginRuntimeConfigurationPort,
  projectManifestConfigurationEnv,
} from '../manifest-configuration-projection.js';
import type { ExternalPluginRuntimeSupervisorOptions } from './types.js';
import { ExternalPluginRuntimeError } from './types.js';

export interface RunnableAuthority {
  readonly instance: PluginInstanceRecord;
  readonly packageRecord: PluginPackageRecord;
  /** F202 C1 gap C: the grant set a config/secret projection must be checked against. */
  readonly grants: PluginGrantRecord | undefined;
}

/** Only the two collaborators the authority questions actually need. */
export type StartAuthorityDeps = Pick<ExternalPluginRuntimeSupervisorOptions, 'inventory' | 'configuration'>;

/**
 * A Host that offers no configuration port can read no stored value. Expressing that as a port
 * rather than an early return keeps one authority over "may this child start" — the projector.
 */
const UNREADABLE_CONFIGURATION: PluginRuntimeConfigurationPort = {
  readConfig: async () => undefined,
  readSecret: async () => undefined,
};

/** Resolves the instance + package + grants a start is allowed to proceed from. */
export async function resolveRunnableAuthority(
  deps: StartAuthorityDeps,
  pluginInstanceId: string,
): Promise<RunnableAuthority> {
  const snapshot = await deps.inventory.snapshot();
  const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
  const current = instance
    ? snapshot.instances.find(
        (candidate) => candidate.pluginId === instance.pluginId && candidate.lifecycleState === 'installed',
      )
    : undefined;
  const packageRecord = instance
    ? snapshot.packages.find(
        (candidate) => candidate.packageDigest === instance.packageDigest && candidate.packageState === 'installed',
      )
    : undefined;
  if (
    !instance ||
    current?.pluginInstanceId !== pluginInstanceId ||
    instance.lifecycleState !== 'installed' ||
    instance.configReadiness !== 'ready' ||
    instance.activationState !== 'enabled' ||
    (instance.runtimeState !== 'stopped' && instance.runtimeState !== 'crashed') ||
    !packageRecord
  ) {
    throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', `${pluginInstanceId} is not a runnable instance`);
  }
  const grants = snapshot.grants.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
  return { instance, packageRecord, grants };
}

/**
 * Re-reads the inventory and refuses when anything the start decision depended on has moved.
 * Mirrors the builtin supervisor's fence so the two runtimes cannot drift on what "the authority
 * I read is still mine" means.
 */
export async function assertAuthorityUnchanged(
  deps: StartAuthorityDeps,
  authority: RunnableAuthority,
  runtimeState: RuntimeState,
): Promise<void> {
  const snapshot = await deps.inventory.snapshot();
  const pluginInstanceId = authority.instance.pluginInstanceId;
  const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
  const grants = snapshot.grants.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
  if (
    !instance ||
    instance.lifecycleState !== 'installed' ||
    instance.packageDigest !== authority.instance.packageDigest ||
    instance.activationState !== 'enabled' ||
    instance.configReadiness !== 'ready' ||
    instance.runtimeState !== runtimeState ||
    grants?.grantRevision !== authority.grants?.grantRevision
  ) {
    throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', `${pluginInstanceId} authority changed during start`);
  }
}

/** Projects the manifest-declared configuration the child may receive, or refuses. */
export async function projectStartConfiguration(
  deps: StartAuthorityDeps,
  authority: RunnableAuthority,
): Promise<Readonly<Record<string, string>>> {
  const declared = authority.packageRecord.manifest.configuration ?? [];
  if (declared.length === 0) return {};
  // An absent configuration port is *no readable value*, not *no declared requirement*
  // (sixth-round review P1). Returning {} here used to start a child whose manifest declared a
  // required secret, so the absent port is expressed as a port that reads nothing and the
  // projector's own fail-closed rule decides the outcome.
  const configuration = deps.configuration ?? UNREADABLE_CONFIGURATION;
  try {
    return await projectManifestConfigurationEnv({
      pluginInstanceId: authority.instance.pluginInstanceId,
      manifest: authority.packageRecord.manifest,
      effectiveGrants: authority.grants?.effectiveGrants ?? [],
      configuration,
    });
  } catch (error) {
    if (error instanceof ManifestConfigurationProjectionError) {
      throw new ExternalPluginRuntimeError('CONFIG_UNAVAILABLE', error.message, { cause: error });
    }
    throw error;
  }
}
