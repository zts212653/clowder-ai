import {
  MATTER_DIRECTORY_UNAVAILABLE,
  type MatterDispatchInput,
  matterBusinessFailureSchema,
  matterOutputSchemas,
} from '@clowder-ai/plugin-memory-contract/matter';
import type { z } from 'zod';
import { MatterMemoryError } from '../domains/memory/matters/matter-source.js';
import type { PluginCallContext } from '../domains/plugin/carrier/plugin-call-context.js';
import {
  type MemoryPluginHost,
  MemoryProviderCallError,
} from '../domains/plugin/host-surface/memory/memory-plugin-host.js';
import type { MatterRouteProvider } from './memory-matter-routes.js';

export async function readMatterOpeningPrompt(provider: MemoryPluginHost, caller: PluginCallContext) {
  const outcome = await provider.attempt({ operation: 'matter.opening', input: {} }, caller);
  if (outcome.status === 'failed') return MATTER_DIRECTORY_UNAVAILABLE;
  const response = matterOutputSchemas['matter.opening'].safeParse(outcome.value);
  return response.success ? response.data : MATTER_DIRECTORY_UNAVAILABLE;
}

export function createMatterRouteProvider(provider: MemoryPluginHost): MatterRouteProvider {
  return (caller) => {
    async function invoke<T>(request: MatterDispatchInput, schema: z.ZodType<T>): Promise<T> {
      const outcome = await provider.attempt(request, caller);
      if (outcome.status === 'failed') throw new MemoryProviderCallError(outcome.effect);
      const response = schema.safeParse(outcome.value);
      if (response.success) return response.data;
      const failure = matterBusinessFailureSchema.safeParse(outcome.value);
      if (failure.success) throw new MatterMemoryError(failure.data.code, failure.data.detail);
      throw new MemoryProviderCallError('unknown');
    }

    return {
      catalog: (_actor, options = {}) => {
        const { query, cursor, limit, management } = options;
        return invoke(
          { operation: 'matter.catalog', input: { query, cursor, limit, management } },
          matterOutputSchemas['matter.catalog'],
        );
      },
      read: (_actor, matterId, options = {}) =>
        invoke({ operation: 'matter.read', input: { matterId, options } }, matterOutputSchemas['matter.read']),
      readForInvocation: (_scope, _catId, matterId, options = {}) =>
        invoke(
          { operation: 'matter.read_for_invocation', input: { matterId, options } },
          matterOutputSchemas['matter.read_for_invocation'],
        ),
      selectSource: (_actor, input) =>
        invoke({ operation: 'matter.select_source', input }, matterOutputSchemas['matter.select_source']),
      write: (_actor, input) => invoke({ operation: 'matter.write', input }, matterOutputSchemas['matter.write']),
      writeSnapshot: (_actor, matterId, ref) =>
        invoke(
          { operation: 'matter.write_snapshot', input: { matterId, ref } },
          matterOutputSchemas['matter.write_snapshot'],
        ),
    };
  };
}
