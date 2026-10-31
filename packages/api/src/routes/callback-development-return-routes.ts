import { type DevelopmentReturnActionV1, developmentReturnActionV1Schema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DevelopmentReturnService } from '../infrastructure/scheduler/development-return/DevelopmentReturnService.js';
import {
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackAuth,
} from './callback-auth-prehandler.js';
import { deriveCallbackActor } from './callback-scope-helpers.js';

interface ReturnRoutesDeps {
  registry: CallbackAuthRegistry;
  service: Pick<DevelopmentReturnService, 'register' | 'readForActor' | 'report'>;
}

const actionFields = {
  read: ['action', 'registrationId'],
  report: ['action', 'registrationId', 'report'],
  register: [
    'action',
    'taskId',
    'expectedRevision',
    'executionThreadId',
    'predecessorRegistrationId',
    'sourceActionRef',
    'expectedSignal',
    'slaUntil',
  ],
} as const;
function validAction(input: DevelopmentReturnActionV1): boolean {
  const fields: readonly string[] = actionFields[input.action];
  if (Object.keys(input).some((key) => !fields.includes(key))) return false;
  if (input.action === 'read') return true;
  return fields.filter((key) => key !== 'predecessorRegistrationId').every((key) => Object.hasOwn(input, key));
}

export async function registerCallbackDevelopmentReturnRoutes(
  app: FastifyInstance,
  deps: ReturnRoutesDeps,
): Promise<void> {
  await app.register(async (scope) => {
    registerCallbackAuthHook(scope, deps.registry);
    scope.post('/api/callbacks/development-return', (request, reply) =>
      handleDevelopmentReturnRequest(request, reply, deps),
    );
  });
}

async function handleDevelopmentReturnRequest(request: FastifyRequest, reply: FastifyReply, deps: ReturnRoutesDeps) {
  reply.header('Cache-Control', 'private, no-store');
  const auth = requireCallbackAuth(request, reply);
  if (!auth) return;
  const parsed = developmentReturnActionV1Schema.safeParse(request.body);
  if (!parsed.success || !validAction(parsed.data))
    return reply.code(400).send({ error: 'Invalid development return action' });
  const input = parsed.data,
    actor = deriveCallbackActor(auth);
  try {
    if (input.action === 'read') return deps.service.readForActor(actor, input.registrationId);
    if (input.action === 'register') return await deps.service.register(actor, input, auth.ownerAuthProvenance);
    if (input.registrationId && input.report)
      return await deps.service.report(actor, input.registrationId, input.report);
  } catch (error) {
    return reply
      .code(409)
      .send({ error: error instanceof Error ? error.message : 'Development return action rejected' });
  }
}
