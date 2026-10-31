import type { DeploymentObservationV1, DeploymentService, DeploymentSubjectRef } from '@cat-cafe/shared';
import { resolveRuntimeDeploymentInclusionProof } from '../../config/runtime-deployment-inclusion.js';
import type { DeploymentObservationProvider } from '../../routes/callback-deployment-wait-routes.js';
import type { RuntimeDeploymentLedger } from './RuntimeDeploymentLedger.js';

export function runtimeDeploymentSubjectRef(installationId: string, deploymentId: string): DeploymentSubjectRef {
  return `deployment:${installationId}:${deploymentId}`;
}

export class RuntimeDeploymentObservationProvider implements DeploymentObservationProvider {
  constructor(
    private readonly options: {
      readonly ledger: RuntimeDeploymentLedger;
      readonly runtimeRoot: string;
      readonly installationId: string;
      readonly deploymentId: string;
      readonly bootId: string;
      /** Current facts for this running instance; absent or failed probes fail closed. */
      readonly currentReadyServices?: () => Promise<readonly DeploymentService[]>;
    },
  ) {}

  async observe(input: {
    readonly deploymentId: string;
    readonly targetRevision?: string;
  }): Promise<DeploymentObservationV1 | null> {
    if (input.deploymentId !== this.options.deploymentId) return null;
    let boot = await this.options.ledger.readCurrent(input.deploymentId).catch(() => null);
    if (!boot || boot.bootId !== this.options.bootId || boot.exit) return null;
    const initialBoot = boot;
    const live = (await this.options.currentReadyServices?.().catch(() => [] as DeploymentService[])) ?? [];
    const services = [...new Set(live.filter((service) => service === 'api' || service === 'web'))];
    // A first readiness check may have failed while the service later recovered.
    // Persist its first actual success against the exact boot before returning it.
    const newlyReady = services.filter((service) => !initialBoot.readyServices.includes(service));
    if (newlyReady.length > 0) {
      boot = await this.options.ledger
        .markReady({
          deploymentId: input.deploymentId,
          bootId: this.options.bootId,
          services: newlyReady,
        })
        .catch(() => null);
    } else {
      const current = await this.options.ledger.readCurrent(input.deploymentId).catch(() => null);
      boot = current?.bootId === this.options.bootId ? current : null;
    }
    if (!boot || boot.exit) return null;
    const inclusionProof =
      input.targetRevision && boot.runningRevision
        ? await resolveRuntimeDeploymentInclusionProof({
            runtimeRoot: this.options.runtimeRoot,
            targetRevision: input.targetRevision,
            runningRevision: boot.runningRevision,
          })
        : null;
    return {
      subjectRef: runtimeDeploymentSubjectRef(this.options.installationId, input.deploymentId),
      bootId: boot.bootId,
      bootSequence: boot.bootSequence,
      runningRevision: boot.runningRevision,
      readyServices: services.filter((service) => boot.readyServices.includes(service)),
      observedAt: Date.now(),
      ...(inclusionProof ? { inclusionProof } : {}),
    };
  }
}
