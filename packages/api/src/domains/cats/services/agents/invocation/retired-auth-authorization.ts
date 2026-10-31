import type { AuthInvocationInput } from './IAuthInvocationBackend.js';
import { normalizeToolExecutionPolicy, parseToolExecutionPolicy } from './tool-execution-policy.js';

const RETIRED_BINDING_FIELDS = ['executionGrant', 'collectiveWorkBinding'] as const;

/** Opaque historical diagnostics only; never reconstructed as executable grants. */
export interface RetiredAuthorizationSnapshot {
  readonly toolExecutionPolicy?: string;
  readonly bindingFields: readonly (typeof RETIRED_BINDING_FIELDS)[number][];
}

export function readRetiredAuthorization(fields: Record<string, string>): RetiredAuthorizationSnapshot | undefined {
  const bindingFields = RETIRED_BINDING_FIELDS.filter((key) => Object.hasOwn(fields, key));
  const raw = fields.toolExecutionPolicy;
  let retiredPolicy = false;
  if (Object.hasOwn(fields, 'toolExecutionPolicy')) {
    const policy: unknown = JSON.parse(raw);
    retiredPolicy =
      typeof policy === 'object' &&
      policy !== null &&
      !Array.isArray(policy) &&
      'mode' in policy &&
      (policy.mode === 'collective_participation' || policy.mode === 'collective_work');
    // A retired binding must not mask corruption in a current or unknown policy.
    if (!retiredPolicy && bindingFields.length) parseToolExecutionPolicy(raw);
  }
  if (!retiredPolicy && !bindingFields.length) return undefined;
  return Object.freeze({
    ...(raw ? { toolExecutionPolicy: raw } : {}),
    bindingFields: Object.freeze(bindingFields),
  });
}

/** New credentials must never inherit removed authority fields or policies. */
export function assertCurrentAuthPrincipal(input: AuthInvocationInput): void {
  if (
    [
      'pluginTaskBinding',
      'publicInvocationBinding',
      'executionGrant',
      'collectiveWorkBinding',
      'retiredAuthorization',
    ].some((key) => Object.hasOwn(input, key))
  )
    throw new Error('Unsupported invocation principal');
  if (input.toolExecutionPolicy) normalizeToolExecutionPolicy(input.toolExecutionPolicy);
}
