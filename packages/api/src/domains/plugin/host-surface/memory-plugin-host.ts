import { randomUUID } from 'node:crypto';
import type { DispatchInput } from '@clowder-ai/plugin-memory-contract';
import { explainDescriptor, isCompatibleDescriptor, MEMORY_REQUIRED_OPERATIONS } from '@clowder-ai/plugin-memory-contract';
import { type EntityDispatchInput, entityOutputSchemas } from '@clowder-ai/plugin-memory-contract/entity';
import { type EventDispatchInput, eventOutputSchemas } from '@clowder-ai/plugin-memory-contract/event';
import { type MatterDispatchInput, matterOutputSchemas } from '@clowder-ai/plugin-memory-contract/matter';
import { type ProfileDispatchInput, profileOutputSchemas } from '@clowder-ai/plugin-memory-contract/profile';
import { type TasteBrowseDispatchInput, tasteBrowseOutputSchemas } from '@clowder-ai/plugin-memory-contract/taste';
import type { z } from 'zod';
import {
  invocationNotStarted,
  type PluginInvocationEffect,
  type PluginInvocationOutcome,
} from '../carrier/host-invocation.js';
import {
  type PluginCallContext,
  withoutPluginCallContext,
  withPluginCallContext,
} from '../carrier/plugin-call-context.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';
import type { DeclaredActionSurface } from '../declared/declared-cloud-conversation-hosts.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginPackageRecord } from '../host-inventory/types.js';

export const MEMORY_PLUGIN_ID = 'official.memory';
export const MEMORY_PACKAGE_NAME = '@clowder-ai/memory-plugin';
export const MEMORY_HOST_REQUIRED_OPERATIONS = [
  ...MEMORY_REQUIRED_OPERATIONS,
  ...Object.keys(matterOutputSchemas),
  ...Object.keys(eventOutputSchemas),
  ...Object.keys(profileOutputSchemas),
  ...Object.keys(entityOutputSchemas),
  ...Object.keys(tasteBrowseOutputSchemas),
];

export class MemoryProviderCallError extends Error {
  constructor(readonly effect: PluginInvocationEffect) {
    super('memory_unavailable');
  }
}

type MemoryDispatch =
  | DispatchInput
  | EntityDispatchInput
  | EventDispatchInput
  | MatterDispatchInput
  | ProfileDispatchInput
  | TasteBrowseDispatchInput;

export async function callMemoryOwner<T>(
  provider: MemoryPluginHost,
  request: MemoryDispatch,
  schema: z.ZodType<T>,
  userId: string,
  scope: { threadId?: string; privateOwnerAccess?: boolean } = {},
): Promise<T> {
  const outcome = await provider.attempt(request, {
    catId: 'user',
    userId,
    threadId: scope.threadId ?? 'default',
    memoryPrivateOwnerAccess: scope.privateOwnerAccess,
    invocationId: randomUUID(),
    assertCurrent: async () => {},
  });
  if (outcome.status === 'failed') throw new MemoryProviderCallError(outcome.effect);
  const response = schema.safeParse(outcome.value);
  if (!response.success) throw new MemoryProviderCallError('unknown');
  return response.data;
}

export function isAdmittedMemoryPackage(record: PluginPackageRecord): boolean {
  const origin = record.provenance;
  return (
    record.pluginId === MEMORY_PLUGIN_ID &&
    origin?.kind === 'catalog' &&
    origin.catalogId === MEMORY_PLUGIN_ID &&
    origin.packageName === MEMORY_PACKAGE_NAME
  );
}

/** One live binding to the approved provider, revoked by the existing F202 lifecycle. */
export class MemoryPluginHost {
  #nextActivation = 0;
  #binding?: {
    identity: { pluginInstanceId: string; pluginVersion: string; packageDigest: string; memoryActivation: number };
    actions: DeclaredActionSurface;
    ready: boolean;
  };

  constructor(private readonly logger?: Pick<import('fastify').FastifyBaseLogger, 'debug' | 'info'>) {}

  async admit({ instance, packageRecord }: PluginRuntimeAdmission, actions?: DeclaredActionSurface) {
    if (packageRecord.pluginId !== MEMORY_PLUGIN_ID) return;
    if (!isAdmittedMemoryPackage(packageRecord)) {
      throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'Memory requires a verified official package');
    }
    const instanceId = instance.pluginInstanceId;
    if (!actions || !(await actions.exposes(instanceId, 'memory.dispatch'))) {
      throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'Memory package does not expose memory.dispatch');
    }
    const descriptor = await withoutPluginCallContext(() => actions.attempt(instanceId, 'memory.describe', {}));
    if (descriptor.status === 'failed') {
      throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'Memory package could not describe its capabilities');
    }
    const offered = descriptor.value;
    if (!isCompatibleDescriptor(offered)) {
      throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', explainDescriptor(offered));
    }
    const missing = MEMORY_HOST_REQUIRED_OPERATIONS.filter((operation) => !offered.operations.includes(operation));
    if (missing.length) {
      throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', `Memory package is missing operations: ${missing.join(', ')}`);
    }
    this.#binding = {
      identity: {
        pluginInstanceId: instanceId,
        pluginVersion: packageRecord.version,
        packageDigest: packageRecord.packageDigest,
        memoryActivation: ++this.#nextActivation,
      },
      actions,
      ready: false,
    };
  }

  markReady(instanceId: string) {
    const binding = this.#binding;
    if (binding?.identity.pluginInstanceId !== instanceId) return;
    binding.ready = true;
    this.logger?.info(binding.identity, 'Memory plugin activated');
  }

  deactivate(instanceId: string) {
    if (this.#binding?.identity.pluginInstanceId === instanceId) this.#binding = undefined;
  }

  isReady() {
    return this.#binding?.ready === true;
  }

  attempt(
    request: MemoryDispatch,
    caller: PluginCallContext,
  ): Promise<PluginInvocationOutcome> {
    const binding = this.#binding;
    if (!binding?.ready) return Promise.resolve(invocationNotStarted(new Error('memory_unavailable')));
    const { pluginInstanceId } = binding.identity;
    const assertActivation = () => {
      if (this.#binding !== binding) throw new Error('memory_activation_changed');
    };
    const scopedCaller: PluginCallContext = {
      ...caller,
      assertCurrent: async () => {
        assertActivation();
        await caller.assertCurrent();
        assertActivation();
      },
    };
    return withPluginCallContext(pluginInstanceId, scopedCaller, async () => {
      const outcome = await binding.actions.attempt(pluginInstanceId, 'memory.dispatch', request);
      this.logger?.debug(
        {
          ...binding.identity,
          invocationId: caller.invocationId,
          operation: request.operation,
          status: outcome.status,
          ...(outcome.status === 'failed' ? { effect: outcome.effect } : {}),
        },
        'Memory plugin operation',
      );
      return outcome;
    });
  }
}
