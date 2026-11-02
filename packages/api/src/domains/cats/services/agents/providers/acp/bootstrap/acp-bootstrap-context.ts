import { dirname } from 'node:path';
import type { AcpVariantConfig } from '../../../../../../../config/cat-config-loader.js';
import { buildChildEnv } from '../../../../../../../utils/cli-spawn.js';
import type { PoolKey } from '../AcpProcessPool.js';
import { resolveAcpBootstrapArgs, resolveAcpBootstrapCommand, resolveAcpBootstrapCwd } from '../acp-bootstrap-cwd.js';
import { auditedWindowsAcpStartup } from './acp-bootstrap-startup-policy.js';

export interface AcpBootstrapContext {
  projectRoot: string;
  command: string;
  args: string[];
  model?: string;
  poolKey: PoolKey;
}
export interface VerifiedAcpBootstrapContext extends AcpBootstrapContext {
  cwd: string;
  isolation?: string;
  verifyCwd: (command?: string, args?: string[], env?: NodeJS.ProcessEnv) => string;
}
export function resolveAcpBootstrap(
  projectRoot: string,
  profileId: string,
  acpConfig: AcpVariantConfig,
  effectiveModel: string,
): AcpBootstrapContext {
  const model = effectiveModel.trim() || undefined;
  return {
    projectRoot,
    command: resolveAcpBootstrapCommand(projectRoot, acpConfig.command),
    args: resolveAcpBootstrapArgs(projectRoot, acpConfig.startupArgs, { base_model: model, model }),
    model,
    poolKey: { projectPath: projectRoot, providerProfile: profileId },
  };
}

/** Classify the startup policy, then freeze the chosen root for this pool. */
export function verifyAcpBootstrap(
  base: AcpBootstrapContext,
  profileId: string,
  bootstrapRoot?: string,
  env?: Record<string, string>,
  strictRoot = false,
  launch: { readonly command: string; readonly args: readonly string[] } = base,
): VerifiedAcpBootstrapContext {
  const isolation = auditedWindowsAcpStartup(
    launch.command,
    [...launch.args],
    buildChildEnv(env, { workingDirectory: base.projectRoot }),
  );
  // An owner-selected root is always strict, even for an audited launch chain.
  const options = {
    allowVolumeRootDelete: !strictRoot && isolation !== undefined,
    preserveExistingPermissions: strictRoot,
  };
  const cwd = resolveAcpBootstrapCwd(
    base.projectRoot,
    profileId,
    bootstrapRoot,
    undefined,
    undefined,
    strictRoot ? false : undefined,
    options,
  );
  const verifyCwd = (
    command = launch.command,
    args = [...launch.args],
    childEnv = buildChildEnv(env, { workingDirectory: cwd }),
  ) => {
    if (isolation && auditedWindowsAcpStartup(command, args, childEnv) !== isolation) {
      throw new Error('Windows ACP bootstrap startup policy changed; refusing cold start');
    }
    return resolveAcpBootstrapCwd(base.projectRoot, profileId, dirname(cwd), undefined, undefined, false, options);
  };
  return { ...base, cwd, isolation, verifyCwd };
}
