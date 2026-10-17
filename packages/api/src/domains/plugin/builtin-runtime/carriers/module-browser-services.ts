import type { BrowserServiceContribution, PluginManifest } from '@clowder-ai/plugin-contract';
import { withoutPluginCallContext } from '../../carrier/plugin-call-context.js';
import { ExternalPluginRuntimeError } from '../../external-runtime/types.js';
import type { PluginBrowserServiceHandler } from '../../host-surface/plugin-browser-service-host.js';
import { snapshotModuleAuthority } from './module-authority-snapshot.js';

function violation(message: string): never {
  throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', message);
}
export interface ModuleBrowserServiceAdmission {
  readonly privateMethods: ReadonlySet<string>;
  readonly active: ReadonlyMap<string, BrowserServiceContribution>;
}

/** Manifest validation already forbids public-method collisions; check feature ownership before reservation. */
export function admitModuleBrowserServices(
  manifest: PluginManifest,
  grants: readonly string[],
): ModuleBrowserServiceAdmission {
  const privateMethods = new Set<string>();
  const active = new Map<string, BrowserServiceContribution>();
  for (const contribution of manifest.contributions ?? []) {
    if (contribution.type !== 'browser-service') continue;
    if (privateMethods.has(contribution.action.method)) violation('Duplicate browser-service method');
    privateMethods.add(contribution.action.method);
    const owners = manifest.features.filter((feature) =>
      feature.contributions?.some((ref) => ref.type === 'browser-service' && ref.id === contribution.id),
    );
    if (owners.length !== 1) violation('Browser service requires exactly one feature owner');
    if (owners[0]?.capabilities.every((capability) => grants.includes(capability)))
      active.set(contribution.id, snapshotModuleAuthority(contribution));
  }
  return { privateMethods, active };
}

/** Capture own handlers once and give ordinary callers a table that cannot select private methods. */
export function captureModuleBrowserServices(
  admission: ModuleBrowserServiceAdmission,
  actions: Readonly<Record<string, unknown>>,
  assertActivation: () => void,
): {
  readonly handlers: ReadonlyMap<string, PluginBrowserServiceHandler>;
  readonly publicActions: Readonly<Record<string, unknown>>;
} {
  const handlers = new Map<string, PluginBrowserServiceHandler>();
  for (const [id, contribution] of admission.active) {
    const descriptor = Object.getOwnPropertyDescriptor(actions, contribution.action.method);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function')
      violation('Missing own browser-service handler');
    const handler = descriptor.value as PluginBrowserServiceHandler;
    handlers.set(id, async (input, _native, context) => {
      if (
        context.kind !== 'http' ||
        !['browser', 'local'].includes(context.lane) ||
        context.contributionId !== id ||
        !(context.signal instanceof AbortSignal)
      )
        violation('Invalid browser-service invocation context');
      context.signal.throwIfAborted();
      assertActivation();
      await context.assertCurrent();
      context.signal.throwIfAborted();
      assertActivation();
      return withoutPluginCallContext(() => handler.call(actions, input, undefined, context));
    });
  }
  if (admission.privateMethods.size === 0) return { handlers, publicActions: actions };
  const publicActions: Record<string, unknown> = Object.create(null);
  const activeMethods = new Set([...admission.active.values()].map((item) => item.action.method));
  for (const method of admission.privateMethods) {
    if (!activeMethods.has(method) && method in actions)
      violation('Inactive browser service cannot register a handler');
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(actions))) {
    if (!admission.privateMethods.has(key)) Object.defineProperty(publicActions, key, descriptor);
  }
  return { handlers, publicActions: Object.freeze(publicActions) };
}
