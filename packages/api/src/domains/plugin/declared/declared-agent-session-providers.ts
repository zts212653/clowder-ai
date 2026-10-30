import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { CatId } from '@cat-cafe/shared';
import { type SessionImplementationRegistry } from '../../cats/services/agents/session-contract/implementation-registry.js';
import {
  AGENT_PROVIDER_DECLARATION_FILE,
  type AgentProviderDeclaration,
  parseAgentProviderDeclaration,
} from '../../cats/services/agents/session-contract/plugin-agent-provider.js';
import { registerPluginAgentProvider } from '../../cats/services/agents/session-contract/plugin-agent-provider-registration.js';
import type { RegisteredSessionAgentService } from '../../cats/services/agents/session-contract/registered-session-agent-service.js';
import type { SessionContractSettings } from '../../cats/services/agents/session-contract/session-contract-settings.js';
import type { AgentSessionProvider } from '../../cats/services/agents/session-contract/types.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';
import type { VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import type { PluginRuntimeConfigurationPort } from '../manifest-configuration-projection.js';
import { resolveAgentClientLibrary } from './agent-client-library.js';
import { resolvePackageFile } from './declared-resource-paths.js';
export interface AgentSessionProviderLifecycle {
  activate(admission: PluginRuntimeAdmission): Promise<(() => Promise<void>) | undefined>;
}
async function completeServiceCalls(
  services: readonly RegisteredSessionAgentService[],
  operation: (service: RegisteredSessionAgentService) => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(services.map(async (service) => operation(service)));
  const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Agent service lifecycle operations failed');
}
async function retireRegistrations(
  registrations: ReturnType<typeof registerPluginAgentProvider>[],
  services: readonly RegisteredSessionAgentService[],
  reason: string,
): Promise<void> {
  // Stop invocation bridges first; resource disposal must also run if that fails.
  const results = await Promise.allSettled([completeServiceCalls(services, (service) => service.releaseAll(reason))]);
  results.push(...(await Promise.allSettled(registrations.map((registration) => registration.disposeHostServices()))));
  const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Agent registration disposal failed');
}
export function declaredAgentSessionProviders(input: {
  settings: SessionContractSettings;
  packages: VerifiedPluginPackageLocator;
  registry: SessionImplementationRegistry;
  services: ReadonlyMap<string, RegisteredSessionAgentService>;
  configuration?: Pick<PluginRuntimeConfigurationPort, 'readConfig'>;
  log?: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  createProvider(declaration: AgentProviderDeclaration, ctx: { catId: CatId }): AgentSessionProvider;
}): AgentSessionProviderLifecycle {
  return {
    async activate(admission) {
      if (input.settings.mode === 'off') return;
      const { manifest, provenance } = admission.packageRecord;
      // Historical Host-bundled packages have no admitted archive to discover providers in.
      // Archive-admitted packages and executable modules still require full verification.
      if (
        provenance === undefined &&
        manifest.runtime?.transport === 'builtin' &&
        manifest.runtime.entrypoint === undefined
      )
        return;
      const pluginId = admission.packageRecord.pluginId;
      let providerId = 'unknown';
      const log = (result: string, reason?: string) =>
        input.log?.[result === 'rejected' ? 'warn' : 'info'](
          { pluginId, providerId, protocol: 'acp', result, ...(reason ? { reason } : {}) },
          `[session-contract] agent-provider ${result}`,
        );
      const located = await input.packages.resolveInstalledPackage(admission.packageRecord.packageDigest);
      try {
        if (!isDeepStrictEqual(located.manifest, admission.packageRecord.manifest))
          throw new Error('Agent provider package authority mismatch');
        await located.verifyIntegrity();
        let path: string;
        try {
          path = await resolvePackageFile(
            located.rootDir,
            AGENT_PROVIDER_DECLARATION_FILE,
            'Agent provider declaration',
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        const raw = await readDeclaration(path);
        await located.verifyIntegrity();
        providerId = declarationId(raw);
        const result = parseAgentProviderDeclaration(raw, { packageRoot: located.rootDir });
        if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
        const declarations = await resolveAgentClientLibrary({
          declaration: result.declaration,
          admission,
          packageRoot: located.rootDir,
          configuration: input.configuration ?? { readConfig: async () => undefined },
        });
        const registrations: ReturnType<typeof registerPluginAgentProvider>[] = [];
        const boundServices = () =>
          [...input.services.values()].filter((service) =>
            registrations.some((registration) => service.implementationKey === registration.key),
          );
        let preparingServices: RegisteredSessionAgentService[] = [];
        try {
          for (const declaration of declarations)
            registrations.push(
              registerPluginAgentProvider(input.registry, {
                pluginId: admission.packageRecord.pluginId,
                declaration,
                createProvider: input.createProvider,
              }),
            );
          preparingServices = boundServices();
          await completeServiceCalls(preparingServices, (service) => service.prepare());
        } catch (error) {
          for (const registration of registrations) registration.unregister();
          // Keep the started instances even if the member map changed while preparing.
          const retiringServices = [...new Set([...preparingServices, ...boundServices()])];
          try {
            await retireRegistrations(registrations, retiringServices, 'implementation_unavailable');
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], `Agent preparation rollback failed: ${String(error)}`);
          }
          throw error;
        }
        log('registered');
        return async () => {
          for (const registration of registrations) registration.unregister();
          log('unregistered');
          await retireRegistrations(registrations, boundServices(), 'implementation_unregistered');
        };
      } catch (error) {
        log('rejected', String(error));
        throw error;
      } finally {
        await located.release();
      }
    },
  };
}

function declarationId(raw: unknown): string {
  return raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string' ? raw.id.slice(0, 128) : 'unknown';
}

export async function readDeclaration(path: string): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    if (size > 65536) throw new Error('Agent provider declaration exceeds 64 KiB');
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== size) throw new Error('Agent provider declaration changed while reading');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await file.close();
  }
}
