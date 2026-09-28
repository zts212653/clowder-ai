import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  requireCapabilityWriteOwner,
  requireLocalCapabilityReadRequest,
  requireLocalCapabilityWriteRequest,
  resolveCapabilityWriteSessionUserId,
} from '../config/capabilities/capability-write-guards.js';
import { toolExecutionPolicyDenial } from '../domains/cats/services/agents/invocation/tool-execution-policy.js';

interface PluginAccess {
  operator: string;
}

interface PluginAccessError {
  status: number;
  error: string;
}

export interface PluginAccessOptions {
  /** Only routes that install callback auth in their own Fastify scope may enable this. */
  allowVerifiedCallbackPrincipal?: boolean;
}

function resolvePluginOperator(request: FastifyRequest, options: PluginAccessOptions): PluginAccess | null {
  const sessionOperator = resolveCapabilityWriteSessionUserId(request);
  if (sessionOperator) return { operator: sessionOperator };
  if (!options.allowVerifiedCallbackPrincipal || !request.callbackPrincipal) return null;
  const ownerError = requireCapabilityWriteOwner(request.callbackPrincipal.userId, { allowMissingOwner: true });
  if (ownerError) return null;
  return { operator: `cat:${request.callbackPrincipal.catId}` };
}

export function requirePluginReadAccess(
  request: FastifyRequest,
  options: PluginAccessOptions = {},
): PluginAccess | PluginAccessError {
  const operator = resolvePluginOperator(request, options);
  if (!operator) {
    return { status: 401, error: 'Plugin read endpoint requires an authenticated session' };
  }

  return operator;
}

export function requirePluginOwnerLocalAccess(
  request: FastifyRequest,
  operation: 'read' | 'write',
  options: PluginAccessOptions = {},
): PluginAccess | PluginAccessError {
  const localError =
    operation === 'read' ? requireLocalCapabilityReadRequest(request) : requireLocalCapabilityWriteRequest(request);
  if (localError) {
    return { status: localError.status, error: `Plugin ${operation} endpoint requires direct localhost Hub access` };
  }

  if (
    operation === 'write' &&
    toolExecutionPolicyDenial(request.callbackAuth?.toolExecutionPolicy, 'cat_cafe_plugin_manager_mutation')
  ) {
    return { status: 403, error: 'Plugin write endpoint is unavailable to a restricted invocation' };
  }

  const access = resolvePluginOperator(request, options);
  if (!access) {
    return { status: 401, error: `Plugin ${operation} endpoint requires an authenticated owner session` };
  }

  const ownerUserId = request.callbackPrincipal?.userId ?? access.operator;
  const ownerError = requireCapabilityWriteOwner(ownerUserId, { allowMissingOwner: true });
  if (ownerError) {
    return { status: ownerError.status, error: `Plugin ${operation} endpoint requires configured owner authorization` };
  }

  return access;
}

export function requirePluginWriteAccess(
  request: FastifyRequest,
  options: PluginAccessOptions = {},
): PluginAccess | PluginAccessError {
  return requirePluginOwnerLocalAccess(request, 'write', options);
}

export function pluginAccessError(reply: FastifyReply, error: PluginAccessError): { error: string } {
  reply.status(error.status);
  return { error: error.error };
}
