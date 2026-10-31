import type { CallbackPrincipal } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AuditEventInput, EventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import {
  ExternalRuntimeSessionRegistrationError,
  registerExternalRuntimeSession,
} from '../domains/cats/services/runtime-session/ExternalRuntimeSessionRegistration.js';
import type { IRuntimeSessionStore } from '../domains/cats/services/runtime-session/RuntimeSessionStore.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { requireCallbackPrincipal } from './callback-auth-prehandler.js';

export interface CallbackRuntimeSessionRouteOptions {
  sessionChainStore: ISessionChainStore;
  runtimeSessionStore: IRuntimeSessionStore;
  threadStore: IThreadStore;
  eventAuditLog?: Pick<EventAuditLog, 'append'>;
}

export function registerCallbackRuntimeSessionRoutes(
  app: FastifyInstance,
  opts: CallbackRuntimeSessionRouteOptions,
): void {
  app.post('/api/callbacks/external-runtime-sessions/register', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    if (principal.kind !== 'agent_key') {
      reply.status(403);
      return { error: 'external_runtime_registration_requires_agent_key' };
    }

    try {
      const result = await registerExternalRuntimeSession(request.body, principal, {
        sessionChainStore: opts.sessionChainStore,
        runtimeSessionStore: opts.runtimeSessionStore,
        threadStore: opts.threadStore,
      });
      await appendExternalRuntimeRegistrationAudit(opts.eventAuditLog ?? getEventAuditLog(), principal, result);
      return result;
    } catch (err) {
      return sendRegistrationError(reply, err);
    }
  });
}

async function appendExternalRuntimeRegistrationAudit(
  auditLog: Pick<EventAuditLog, 'append'>,
  principal: Extract<CallbackPrincipal, { kind: 'agent_key' }>,
  result: Awaited<ReturnType<typeof registerExternalRuntimeSession>>,
): Promise<void> {
  const input: AuditEventInput = {
    type: AuditEventTypes.EXTERNAL_RUNTIME_SESSION_REGISTERED,
    threadId: result.threadId,
    data: {
      agentKeyId: principal.agentKeyId,
      runtime: result.runtime,
      runtimeSessionId: result.runtimeSessionId,
      runtimeConversationId: result.runtimeConversationId,
      sessionId: result.sessionId,
      bindingMode: result.binding.mode,
      catId: result.catId,
      status: result.status,
    },
  };
  await auditLog.append(input);
}

function sendRegistrationError(reply: FastifyReply, err: unknown): { error: string; message?: string } {
  if (err instanceof ExternalRuntimeSessionRegistrationError) {
    reply.status(err.statusCode);
    return { error: err.code, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'external runtime registration requires agent-key principal') {
    reply.status(403);
    return { error: 'external_runtime_registration_requires_agent_key', message };
  }
  if (message === 'payload catId must match agent-key principal') {
    reply.status(403);
    return { error: 'external_runtime_cat_spoofing_forbidden', message };
  }
  if (isExternalRuntimeRegistrationValidationError(message)) {
    reply.status(400);
    return { error: 'invalid_external_runtime_registration', message };
  }
  reply.status(500);
  return { error: 'external_runtime_registration_failed', message };
}

function isExternalRuntimeRegistrationValidationError(message: string): boolean {
  return EXTERNAL_RUNTIME_REGISTRATION_VALIDATION_ERRORS.some((pattern) => pattern.test(message));
}

const EXTERNAL_RUNTIME_REGISTRATION_VALIDATION_ERRORS = [
  /^external runtime session registration must be an object$/,
  /^catId must be a non-empty string$/,
  /^invalid catId: /,
  /^invalid external runtime$/,
  /^startedAt must be a finite number$/,
  /^lastObservedAt must be a finite number$/,
  /^lastObservedAt must not precede startedAt$/,
  /^runtimeSessionId must be a non-empty string$/,
  /^runtimeConversationId must be a non-empty string$/,
  /^model must be a non-empty string$/,
  /^title must be a non-empty string$/,
  /^binding must be an object$/,
  /^binding\.mode must be a non-empty string$/,
  /^binding\.threadId must be a non-empty string$/,
  /^invalid binding\.mode$/,
  /^provenance must be an object$/,
  /^source must be a non-empty string$/,
  /^invalid provenance\.source$/,
  /^ideWindowId must be a non-empty string$/,
  /^workspacePath must be a non-empty string$/,
  /^runtimeUrl must be a non-empty string$/,
  /^note must be a non-empty string$/,
  /^clientRegistrationId must be a non-empty string$/,
];
