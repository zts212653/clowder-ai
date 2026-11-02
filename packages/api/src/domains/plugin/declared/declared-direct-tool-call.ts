import type { DirectToolContribution } from '@clowder-ai/plugin-contract';
import {
  type PluginCallContext,
  withoutPluginCallContext,
  withPluginCallContext,
} from '../carrier/plugin-call-context.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

export interface DeclaredPluginTool {
  readonly contributionId: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties?: Readonly<Record<string, object>>;
    readonly required?: readonly string[];
    readonly $schema?: string;
  };
}

export type DeclaredPluginToolCall = { readonly handled: false } | { readonly handled: true; readonly value: unknown };

export function directToolSchema(tool: DirectToolContribution): DeclaredPluginTool['inputSchema'] {
  const schema = tool.inputSchema;
  if (schema.type !== 'object') {
    throw new ExternalPluginRuntimeError(
      'PROTOCOL_VIOLATION',
      `Tool contribution ${tool.id} must declare an object input schema`,
    );
  }
  return schema as DeclaredPluginTool['inputSchema'];
}

/** The declared activation and the HTTP caller must both stay current across package awaits. */
export async function invokeDeclaredDirectTool(input: {
  readonly binding: {
    readonly pluginInstanceId: string;
    readonly packageDigest: string;
    readonly lifetime: AbortController;
  };
  readonly isCurrent: () => boolean;
  readonly invoke: () => Promise<unknown>;
  readonly caller: PluginCallContext | undefined;
  readonly resolveAdmission: ((id: string) => Promise<PluginRuntimeAdmission>) | undefined;
}): Promise<unknown> {
  const { binding, caller } = input;
  const checkCaller = caller?.assertCurrent.bind(caller);
  const checkInvocation = caller?.assertInvocationCurrent?.bind(caller);
  let finished = false;
  const assertActive = () => {
    if (finished || binding.lifetime.signal.aborted || !input.isCurrent())
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Direct tool call is no longer current');
  };
  // Task writes hold the inventory transaction. This fence must never reread it.
  const assertInvocationCurrent = async () => {
    assertActive();
    if (caller && !checkInvocation)
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Invocation-only write fence is unavailable');
    await checkInvocation?.();
    assertActive();
  };
  const assertCurrent = async () => {
    await assertInvocationCurrent();
    await checkCaller?.();
    if (caller && !input.resolveAdmission)
      throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Direct tool admission is unavailable');
    const current = await input.resolveAdmission?.(binding.pluginInstanceId);
    if (
      current &&
      (current.instance.activationState !== 'enabled' ||
        current.instance.lifecycleState !== 'installed' ||
        current.instance.configReadiness !== 'ready' ||
        current.instance.packageDigest !== binding.packageDigest)
    )
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Direct tool call is no longer current');
    await checkCaller?.();
    await assertInvocationCurrent();
  };
  await assertCurrent();
  try {
    const value = await (caller
      ? withPluginCallContext(
          binding.pluginInstanceId,
          Object.freeze({ ...caller, assertCurrent, assertInvocationCurrent }),
          input.invoke,
        )
      : withoutPluginCallContext(input.invoke));
    await assertCurrent();
    return value;
  } finally {
    finished = true;
  }
}
