import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  requireCapabilityWriteOwner,
  requireLocalCapabilityReadRequest,
  requireLocalCapabilityWriteRequest,
  resolveCapabilityWriteSessionUserId,
} from '../config/capabilities/capability-write-guards.js';

interface PluginAccess {
  operator: string;
}

interface PluginAccessError {
  status: number;
  error: string;
}

export function requirePluginReadAccess(request: FastifyRequest): PluginAccess | PluginAccessError {
  const operator = resolveCapabilityWriteSessionUserId(request);
  if (!operator) {
    return { status: 401, error: 'Plugin read endpoint requires an authenticated session' };
  }

  return { operator };
}

export function requirePluginOwnerLocalAccess(
  request: FastifyRequest,
  operation: 'read' | 'write',
): PluginAccess | PluginAccessError {
  const localError =
    operation === 'read' ? requireLocalCapabilityReadRequest(request) : requireLocalCapabilityWriteRequest(request);
  if (localError) {
    return { status: localError.status, error: `Plugin ${operation} endpoint requires direct localhost Hub access` };
  }

  const operator = resolveCapabilityWriteSessionUserId(request);
  if (!operator) {
    return { status: 401, error: `Plugin ${operation} endpoint requires an authenticated owner session` };
  }

  const ownerError = requireCapabilityWriteOwner(operator, { allowMissingOwner: true });
  if (ownerError) {
    return { status: ownerError.status, error: `Plugin ${operation} endpoint requires configured owner authorization` };
  }

  return { operator };
}

export function requirePluginWriteAccess(request: FastifyRequest): PluginAccess | PluginAccessError {
  return requirePluginOwnerLocalAccess(request, 'write');
}

export function pluginAccessError(reply: FastifyReply, error: PluginAccessError): { error: string } {
  reply.status(error.status);
  return { error: error.error };
}
