/**
 * F162: WeChat Work enterprise action callback routes.
 *
 * Endpoint: POST /api/callbacks/wecom-action
 * Cat calls this via Skill → callback route → WeComActionService (ADR-029 Decision 2).
 * Supports individual actions and the golden chain showcase.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  type CreateDocOpts,
  type CreateMeetingOpts,
  type CreateSmartTableOpts,
  type CreateTodoOpts,
  type GoldenChainOpts,
  WeComActionService,
} from '../infrastructure/enterprise/WeComActionService.js';
import {
  WeComApiError,
  WeComCliExecutor,
  WeComCliUnavailableError,
} from '../infrastructure/enterprise/WeComCliExecutor.js';
import { callbackAuthSchema } from './callback-auth-schema.js';
import { EXPIRED_CREDENTIALS_ERROR } from './callback-errors.js';

const createDocSchema = callbackAuthSchema.extend({
  action: z.literal('create_doc'),
  docName: z.string().min(1).max(200),
  content: z.string().max(500_000).optional(),
});

const createSmartTableSchema = callbackAuthSchema.extend({
  action: z.literal('create_smart_table'),
  tableName: z.string().min(1).max(200),
  fields: z.array(z.object({ fieldTitle: z.string(), fieldType: z.string() })).max(50),
  records: z.array(z.record(z.unknown())).max(200),
});

const createTodoSchema = callbackAuthSchema.extend({
  action: z.literal('create_todo'),
  content: z.string().min(1).max(2000),
  followerUserIds: z.array(z.string()).min(1).max(50),
  remindTime: z.string().optional(),
});

const createMeetingSchema = callbackAuthSchema.extend({
  action: z.literal('create_meeting'),
  title: z.string().min(1).max(200),
  startDatetime: z.string().min(1),
  durationSeconds: z.number().int().min(300).max(86_400),
  inviteeUserIds: z.array(z.string()).min(1).max(100),
});

const goldenChainSchema = callbackAuthSchema.extend({
  action: z.literal('golden_chain'),
  docName: z.string().min(1).max(200),
  docContent: z.string().min(1).max(500_000),
  tableName: z.string().min(1).max(200),
  tasks: z
    .array(
      z.object({
        content: z.string().min(1),
        assigneeUserId: z.string().min(1),
        remindTime: z.string().optional(),
      }),
    )
    .min(1)
    .max(50),
  meetingTitle: z.string().min(1).max(200),
  meetingStart: z.string().min(1),
  meetingDurationSeconds: z.number().int().min(300).max(86_400),
  meetingInviteeUserIds: z.array(z.string()).min(1).max(100),
});

const actionSchema = z.discriminatedUnion('action', [
  createDocSchema,
  createSmartTableSchema,
  createTodoSchema,
  createMeetingSchema,
  goldenChainSchema,
]);

export function registerCallbackWeComActionRoutes(app: FastifyInstance, deps: { registry: InvocationRegistry }): void {
  const executor = new WeComCliExecutor(app.log);
  const service = new WeComActionService(executor, app.log);

  app.post('/api/callbacks/wecom-action', async (request, reply) => {
    const parsed = actionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const body = parsed.data;
    const record = deps.registry.verify(body.invocationId, body.callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    try {
      // Strip auth fields (invocationId/callbackToken/action) before passing to service.
      // TypeScript casts don't remove runtime properties — explicit destructure prevents
      // credential leakage into audit logs (P1 from @codex review).
      switch (body.action) {
        case 'create_doc': {
          const { docName, content } = body;
          return { status: 'ok', result: await service.createDoc({ docName, content }) };
        }
        case 'create_smart_table': {
          const { tableName, fields, records } = body;
          return { status: 'ok', result: await service.createSmartTable({ tableName, fields, records }) };
        }
        case 'create_todo': {
          const { content, followerUserIds, remindTime } = body;
          return { status: 'ok', result: await service.createTodo({ content, followerUserIds, remindTime }) };
        }
        case 'create_meeting': {
          const { title, startDatetime, durationSeconds, inviteeUserIds } = body;
          return {
            status: 'ok',
            result: await service.createMeeting({ title, startDatetime, durationSeconds, inviteeUserIds }),
          };
        }
        case 'golden_chain': {
          const {
            docName,
            docContent,
            tableName,
            tasks,
            meetingTitle,
            meetingStart,
            meetingDurationSeconds,
            meetingInviteeUserIds,
          } = body;
          return {
            status: 'ok',
            result: await service.goldenChain({
              docName,
              docContent,
              tableName,
              tasks,
              meetingTitle,
              meetingStart,
              meetingDurationSeconds,
              meetingInviteeUserIds,
            }),
          };
        }
      }
    } catch (err) {
      if (err instanceof WeComApiError) {
        reply.status(502);
        return { error: 'WeChat Work API error', errcode: err.errcode, errmsg: err.errmsg };
      }
      if (err instanceof WeComCliUnavailableError) {
        reply.status(503);
        return { error: 'wecom-cli unavailable', message: err.message };
      }
      throw err;
    }
  });
}
