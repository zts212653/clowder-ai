import { meetingIntakeNeedsAttention } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveCapabilityWriteSessionUserId } from '../config/capabilities/capability-write-guards.js';
import { MeetingIntakeError } from '../domains/signal-intake/errors.js';
import type { MeetingIntakeActionService } from '../domains/signal-intake/MeetingIntakeActionService.js';
import type { MeetingIntakeService } from '../domains/signal-intake/MeetingIntakeService.js';
import type { MeetingIntakeStore } from '../domains/signal-intake/MeetingIntakeStore.js';

export interface MeetingIntakeRoutesOptions {
  readonly store: MeetingIntakeStore;
  readonly service: MeetingIntakeService;
  readonly actions?: MeetingIntakeActionService;
}

const MANUAL_IMPORT_BODY_LIMIT_BYTES = 2_100_000;

function sessionUser(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = resolveCapabilityWriteSessionUserId(request);
  if (userId) return userId;
  reply.status(401).send({ error: 'Meeting intake endpoint requires an authenticated session' });
  return null;
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof MeetingIntakeError)) throw error;
  const status = error.code === 'INTAKE_NOT_FOUND' ? 404 : error.code === 'REVISION_CONFLICT' ? 409 : 400;
  return reply.status(status).send({ error: error.message, code: error.code });
}

export function registerMeetingIntakeRoutes(app: FastifyInstance, options: MeetingIntakeRoutesOptions): void {
  app.get<{ Querystring: { attention?: string } }>('/api/meeting-intakes', async (request, reply) => {
    const userId = sessionUser(request, reply);
    if (!userId) return;
    const attentionOnly = request.query.attention === 'true';
    const intakes = (await options.store.list()).filter(
      (intake) => intake.ownerId === userId && (!attentionOnly || meetingIntakeNeedsAttention(intake)),
    );
    return { intakes };
  });

  app.get<{ Params: { intakeId: string } }>('/api/meeting-intakes/:intakeId', async (request, reply) => {
    const userId = sessionUser(request, reply);
    if (!userId) return;
    const intake = await options.store.get(request.params.intakeId);
    if (!intake || intake.ownerId !== userId) return reply.status(404).send({ error: 'Meeting intake not found' });
    return { intake };
  });

  app.post<{
    Params: { intakeId: string };
    Body: { expectedRevision?: number; code?: string; safeDetail?: string };
  }>('/api/meeting-intakes/:intakeId/repair', async (request, reply) => {
    const userId = sessionUser(request, reply);
    if (!userId) return;
    const current = await options.store.get(request.params.intakeId);
    if (!current || current.ownerId !== userId) return reply.status(404).send({ error: 'Meeting intake not found' });
    const body = request.body ?? {};
    if (
      typeof body.expectedRevision !== 'number' ||
      !Number.isSafeInteger(body.expectedRevision) ||
      typeof body.code !== 'string'
    ) {
      return reply.status(400).send({ error: 'expectedRevision and repair code are required' });
    }
    try {
      const intake = await options.service.markRepair(request.params.intakeId, body.expectedRevision, {
        code: body.code as Parameters<MeetingIntakeService['markRepair']>[2]['code'],
        ...(body.safeDetail === undefined ? {} : { safeDetail: body.safeDetail }),
      });
      return { intake };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post<{ Params: { intakeId: string }; Body: { expectedRevision?: number } }>(
    '/api/meeting-intakes/:intakeId/repair/clear',
    async (request, reply) => {
      const userId = sessionUser(request, reply);
      if (!userId) return;
      const current = await options.store.get(request.params.intakeId);
      if (!current || current.ownerId !== userId) return reply.status(404).send({ error: 'Meeting intake not found' });
      if (typeof request.body?.expectedRevision !== 'number' || !Number.isSafeInteger(request.body.expectedRevision)) {
        return reply.status(400).send({ error: 'expectedRevision is required' });
      }
      try {
        const intake = await options.service.clearRepair(request.params.intakeId, request.body.expectedRevision);
        return { intake };
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  if (!options.actions) return;

  app.post<{
    Params: { intakeId: string };
    Body: {
      expectedRevision?: number;
      choices?: {
        speakerMap?: Record<string, string>;
        context?: string;
        destinationHandle?: string;
        outputs?: string[];
      };
    };
  }>('/api/meeting-intakes/:intakeId/confirm', async (request, reply) => {
    const userId = sessionUser(request, reply);
    if (!userId) return;
    const body = request.body ?? {};
    const choices = body.choices;
    if (
      typeof body.expectedRevision !== 'number' ||
      !Number.isSafeInteger(body.expectedRevision) ||
      !choices ||
      typeof choices.speakerMap !== 'object' ||
      choices.speakerMap === null ||
      typeof choices.context !== 'string' ||
      typeof choices.destinationHandle !== 'string' ||
      !Array.isArray(choices.outputs)
    ) {
      return reply.status(400).send({ error: 'expectedRevision and complete meeting choices are required' });
    }
    try {
      const intake = await options.actions!.confirm(userId, request.params.intakeId, body.expectedRevision, {
        speakerMap: choices.speakerMap,
        context: choices.context,
        destinationHandle: choices.destinationHandle,
        outputs: choices.outputs as Parameters<MeetingIntakeActionService['confirm']>[3]['outputs'],
      });
      return { intake };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post<{ Params: { intakeId: string }; Body: { expectedRevision?: number } }>(
    '/api/meeting-intakes/:intakeId/dismiss',
    async (request, reply) => {
      const userId = sessionUser(request, reply);
      if (!userId) return;
      if (typeof request.body?.expectedRevision !== 'number' || !Number.isSafeInteger(request.body.expectedRevision)) {
        return reply.status(400).send({ error: 'expectedRevision is required' });
      }
      try {
        return {
          intake: await options.actions!.dismiss(userId, request.params.intakeId, request.body.expectedRevision),
        };
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.post<{ Params: { intakeId: string }; Body: { expectedRevision?: number } }>(
    '/api/meeting-intakes/:intakeId/retry',
    async (request, reply) => {
      const userId = sessionUser(request, reply);
      if (!userId) return;
      if (typeof request.body?.expectedRevision !== 'number' || !Number.isSafeInteger(request.body.expectedRevision)) {
        return reply.status(400).send({ error: 'expectedRevision is required' });
      }
      try {
        return { intake: await options.actions!.retry(userId, request.params.intakeId, request.body.expectedRevision) };
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.post<{ Params: { intakeId: string }; Body: { expectedRevision?: unknown; clientRequestId?: unknown } }>(
    '/api/meeting-intakes/:intakeId/presentation-retry',
    async (request, reply) => {
      const userId = sessionUser(request, reply);
      if (!userId) return;
      const expectedRevision = request.body?.expectedRevision;
      const rawClientRequestId = request.body?.clientRequestId;
      const clientRequestId = typeof rawClientRequestId === 'string' ? rawClientRequestId.trim() : undefined;
      if (
        typeof expectedRevision !== 'number' ||
        !Number.isSafeInteger(expectedRevision) ||
        !clientRequestId ||
        clientRequestId.length > 200 ||
        !/^[A-Za-z0-9._:-]+$/.test(clientRequestId)
      ) {
        return reply.status(400).send({ error: 'expectedRevision and clientRequestId are required' });
      }
      try {
        return await options.actions!.retryPresentation(
          userId,
          request.params.intakeId,
          expectedRevision,
          clientRequestId,
        );
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.post<{ Params: { intakeId: string }; Body: { expectedRevision?: number } }>(
    '/api/meeting-intakes/:intakeId/regrant',
    async (request, reply) => {
      const userId = sessionUser(request, reply);
      if (!userId) return;
      const current = await options.store.get(request.params.intakeId);
      if (!current || current.ownerId !== userId) return reply.status(404).send({ error: 'Meeting intake not found' });
      if (typeof request.body?.expectedRevision !== 'number' || request.body.expectedRevision !== current.revision) {
        return reply.status(409).send({ error: 'Meeting intake revision changed', code: 'REVISION_CONFLICT' });
      }
      if (current.repair?.action !== 'regrant') {
        return reply.status(400).send({ error: 'Meeting intake does not require Feishu authorization' });
      }
      return {
        intake: current,
        regrant: {
          kind: 'official_plugin_auth',
          catalogId: 'feishu-meeting-intake',
          settingsHref: '/settings?s=plugins',
          nextAction: 'retry',
        },
      };
    },
  );

  app.post<{ Params: { intakeId: string }; Body: { expectedRevision?: number; transcript?: string } }>(
    '/api/meeting-intakes/:intakeId/manual-import',
    { bodyLimit: MANUAL_IMPORT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const userId = sessionUser(request, reply);
      if (!userId) return;
      if (
        typeof request.body?.expectedRevision !== 'number' ||
        !Number.isSafeInteger(request.body.expectedRevision) ||
        typeof request.body.transcript !== 'string'
      ) {
        return reply.status(400).send({ error: 'expectedRevision and transcript are required' });
      }
      try {
        return {
          intake: await options.actions!.manualImport(
            userId,
            request.params.intakeId,
            request.body.expectedRevision,
            request.body.transcript,
          ),
        };
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );
}
