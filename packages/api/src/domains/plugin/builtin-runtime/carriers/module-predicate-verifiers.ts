import type { PluginManifest, TerminalPredicateProviderContribution } from '@clowder-ai/plugin-contract';
import { ExternalPluginRuntimeError } from '../../external-runtime/types.js';

export interface ModulePredicateVerifier {
  readonly phase: 'freshness' | 'completion';
  readonly contribution: TerminalPredicateProviderContribution;
  readonly featureId: string;
  readonly handler: (input: unknown, context: unknown) => unknown;
}

function violation(message: string): never {
  throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', message);
}

/** Capture own functions once: a module cannot mutate its table after admission. */
export function admitModulePredicateVerifiers(
  manifest: PluginManifest,
  grants: readonly string[],
  activation: object,
  actions: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, ModulePredicateVerifier> {
  const declared = (manifest.contributions ?? []).filter(
    (item): item is TerminalPredicateProviderContribution => item.type === 'terminal-predicate-provider',
  );
  const methods = new Map<string, Omit<ModulePredicateVerifier, 'handler'>>();
  const allNames = new Set<string>();
  const selectors = new Set<string>();
  for (const contribution of declared) {
    const selector = `${contribution.actionFamily}/${contribution.predicateKind}/${contribution.subjectNamespace}`;
    if (selectors.has(selector)) violation('Duplicate predicate provider selector');
    selectors.add(selector);
    const owners = manifest.features.filter((feature) =>
      feature.contributions?.some((ref) => ref.type === contribution.type && ref.id === contribution.id),
    );
    if (owners.length !== 1 || !owners[0]?.capabilities.includes('custody.verify')) {
      violation('Predicate provider must have exactly one custody.verify feature owner');
    }
    const owner = owners[0];
    if (!owner) violation('Predicate provider feature owner is missing');
    for (const phase of ['freshness', 'completion'] as const) {
      const method = phase === 'freshness' ? contribution.freshnessMethod : contribution.completionMethod;
      if (allNames.has(method) || method in actions) violation(`Predicate verifier ${method} is not private`);
      allNames.add(method);
      if (owner.capabilities.every((capability) => grants.includes(capability))) {
        methods.set(method, { phase, contribution: Object.freeze({ ...contribution }), featureId: owner.id });
      }
    }
  }
  // Even an inactive feature's private method cannot be declared as a public callback.
  for (const contribution of manifest.contributions ?? []) {
    const names: string[] = [];
    if ('action' in contribution) names.push(contribution.action.method);
    if (contribution.type === 'mcp') names.push(...(contribution.actions ?? []).map((action) => action.method));
    if (contribution.type === 'message-subscription' && contribution.lifecycleAction) {
      names.push(contribution.lifecycleAction.method);
    }
    if (contribution.type === 'media-source')
      names.push(contribution.readAction.method, contribution.settleAction.method);
    if (contribution.type === 'cloud-conversation-host') {
      names.push(
        contribution.appendMessage.method,
        contribution.assistantReturns.list.method,
        contribution.assistantReturns.ack.method,
      );
    }
    if (names.some((name) => allNames.has(name))) violation('Predicate verifier cannot be a public callback');
  }
  const descriptor = Object.getOwnPropertyDescriptor(activation, 'predicateVerifiers');
  if (!descriptor && 'predicateVerifiers' in activation) violation('Inherited verifier table');
  if (descriptor && !('value' in descriptor)) violation('Verifier table must be an own data property');
  const table: unknown = descriptor?.value;
  if (table === undefined && methods.size === 0) return new Map();
  if (
    !table ||
    typeof table !== 'object' ||
    Array.isArray(table) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(table))
  )
    violation('Missing or invalid predicate verifier table');
  const result = new Map<string, ModulePredicateVerifier>();
  for (const key of Reflect.ownKeys(table)) {
    const entry = Object.getOwnPropertyDescriptor(table, key);
    const declaredMethod = typeof key === 'string' ? methods.get(key) : undefined;
    if (!declaredMethod || !entry || !('value' in entry) || !entry.enumerable || typeof entry.value !== 'function') {
      violation('Extra, inherited or invalid predicate verifier handler');
    }
    result.set(key as string, Object.freeze({ ...declaredMethod, handler: entry.value }));
  }
  if (result.size !== methods.size) violation('Missing declared predicate verifier handler');
  return result;
}
