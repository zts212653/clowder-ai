import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeploymentService } from '@cat-cafe/shared';
import { resolveRuntimeDeploymentRevision } from '../../config/runtime-deployment-revision.js';
import { RuntimeDeploymentLedger } from './RuntimeDeploymentLedger.js';
import { RuntimeDeploymentObservationProvider } from './RuntimeDeploymentObservationProvider.js';

export interface RuntimeDeploymentProcessContext {
  readonly ledger: RuntimeDeploymentLedger;
  readonly provider: RuntimeDeploymentObservationProvider;
  readonly runtimeRoot: string;
  readonly installationId: string;
  readonly deploymentId: string;
  readonly bootId: string;
  readonly bootSequence: number;
  readonly runningRevision: string | null;
}

export async function beginOwnedRuntimeDeployment(input: {
  readonly runtimeRoot: string | undefined;
  readonly entrypointRoot: string;
  readonly deploymentId: string | undefined;
  readonly dataRoot: string;
  readonly currentReadyServices?: () => Promise<readonly DeploymentService[]>;
}): Promise<RuntimeDeploymentProcessContext | null> {
  const declaredRuntimeRoot = input.runtimeRoot?.trim();
  const deploymentId = input.deploymentId?.trim();
  if (!declaredRuntimeRoot || !deploymentId) return null;

  let runtimeRoot: string;
  let entrypointRoot: string;
  try {
    [runtimeRoot, entrypointRoot] = await Promise.all([realpath(declaredRuntimeRoot), realpath(input.entrypointRoot)]);
  } catch {
    return null;
  }
  if (runtimeRoot !== entrypointRoot) return null;

  const installationId = createHash('sha256').update(runtimeRoot).digest('hex');
  const runningRevision = resolveRuntimeDeploymentRevision(runtimeRoot);
  const ledger = new RuntimeDeploymentLedger({
    file: join(input.dataRoot, 'runtime-deployment', `${installationId}.json`),
    installationId,
  });
  const boot = await ledger.beginBoot({ deploymentId, runningRevision });
  const provider = new RuntimeDeploymentObservationProvider({
    ledger,
    runtimeRoot,
    installationId,
    deploymentId,
    bootId: boot.bootId,
    currentReadyServices: input.currentReadyServices,
  });

  return {
    ledger,
    provider,
    runtimeRoot,
    installationId,
    deploymentId,
    bootId: boot.bootId,
    bootSequence: boot.bootSequence,
    runningRevision,
  };
}
