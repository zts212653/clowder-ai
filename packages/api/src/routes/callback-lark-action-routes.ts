/**
 * F162 Phase B: Lark/Feishu enterprise action callback routes.
 *
 * Endpoint: POST /api/callbacks/lark-action
 * Cat calls this via Skill → callback route → LarkActionService (ADR-029 Decision 2).
 * Supports individual actions and the feishu golden chain showcase.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  type CreateBaseOpts,
  type CreateCalendarEventOpts,
  type CreateDocOpts,
  type CreateSlidesOpts,
  type CreateTaskOpts,
  type GoldenChainOpts,
  LarkActionService,
} from '../infrastructure/enterprise/LarkActionService.js';
import {
  LarkApiError,
  LarkCliExecutor,
  LarkCliProtocolError,
  LarkCliUnavailableError,
} from '../infrastructure/enterprise/LarkCliExecutor.js';
import { callbackAuthSchema } from './callback-auth-schema.js';
import { EXPIRED_CREDENTIALS_ERROR } from './callback-errors.js';

const createDocSchema = callbackAuthSchema.extend({
  action: z.literal('create_doc'),
  title: z.string().min(1).max(200),
  markdown: z.string().max(500_000).optional(),
  folderToken: z.string().optional(),
});

const createBaseSchema = callbackAuthSchema.extend({
  action: z.literal('create_base'),
  name: z.string().min(1).max(200),
  folderToken: z.string().optional(),
  timeZone: z.string().optional(),
});

const createTaskSchema = callbackAuthSchema.extend({
  action: z.literal('create_task'),
  summary: z.string().min(1).max(500),
  description: z.string().max(10_000).optional(),
  assigneeOpenId: z.string().optional(),
  due: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

const createCalendarEventSchema = callbackAuthSchema.extend({
  action: z.literal('create_calendar_event'),
  summary: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  start: z.string().min(1),
  end: z.string().min(1),
  attendeeOpenIds: z.array(z.string()).max(100).optional(),
  calendarId: z.string().optional(),
  rrule: z.string().optional(),
});

const createSlidesSchema = callbackAuthSchema.extend({
  action: z.literal('create_slides'),
  title: z.string().min(1).max(200),
  folderToken: z.string().optional(),
});

const goldenChainSchema = callbackAuthSchema.extend({
  action: z.literal('golden_chain'),
  docTitle: z.string().min(1).max(200),
  docMarkdown: z.string().min(1).max(500_000),
  baseName: z.string().min(1).max(200),
  tasks: z
    .array(
      z.object({
        summary: z.string().min(1),
        assigneeOpenId: z.string().min(1),
        due: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .min(1)
    .max(50),
  calendarSummary: z.string().min(1).max(200),
  calendarStart: z.string().min(1),
  calendarEnd: z.string().min(1),
  calendarAttendeeOpenIds: z.array(z.string()).min(1).max(100),
  includeSlides: z.boolean().optional(),
});

const actionSchema = z.discriminatedUnion('action', [
  createDocSchema,
  createBaseSchema,
  createTaskSchema,
  createCalendarEventSchema,
  createSlidesSchema,
  goldenChainSchema,
]);

export function registerCallbackLarkActionRoutes(app: FastifyInstance, deps: { registry: InvocationRegistry }): void {
  const executor = new LarkCliExecutor(app.log);
  const service = new LarkActionService(executor, app.log);

  app.post('/api/callbacks/lark-action', async (request, reply) => {
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
      switch (body.action) {
        case 'create_doc': {
          const opts: CreateDocOpts = {
            title: body.title,
            ...(body.markdown ? { markdown: body.markdown } : {}),
            ...(body.folderToken ? { folderToken: body.folderToken } : {}),
          };
          return { status: 'ok', result: await service.createDoc(opts) };
        }
        case 'create_base': {
          const opts: CreateBaseOpts = {
            name: body.name,
            ...(body.folderToken ? { folderToken: body.folderToken } : {}),
            ...(body.timeZone ? { timeZone: body.timeZone } : {}),
          };
          return { status: 'ok', result: await service.createBase(opts) };
        }
        case 'create_task': {
          const opts: CreateTaskOpts = {
            summary: body.summary,
            ...(body.description ? { description: body.description } : {}),
            ...(body.assigneeOpenId ? { assigneeOpenId: body.assigneeOpenId } : {}),
            ...(body.due ? { due: body.due } : {}),
            ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
          };
          return { status: 'ok', result: await service.createTask(opts) };
        }
        case 'create_calendar_event': {
          const opts: CreateCalendarEventOpts = {
            summary: body.summary,
            start: body.start,
            end: body.end,
            ...(body.description ? { description: body.description } : {}),
            ...(body.attendeeOpenIds ? { attendeeOpenIds: body.attendeeOpenIds } : {}),
            ...(body.calendarId ? { calendarId: body.calendarId } : {}),
            ...(body.rrule ? { rrule: body.rrule } : {}),
          };
          return { status: 'ok', result: await service.createCalendarEvent(opts) };
        }
        case 'create_slides': {
          const opts: CreateSlidesOpts = {
            title: body.title,
            ...(body.folderToken ? { folderToken: body.folderToken } : {}),
          };
          return { status: 'ok', result: await service.createSlides(opts) };
        }
        case 'golden_chain': {
          const opts: GoldenChainOpts = {
            docTitle: body.docTitle,
            docMarkdown: body.docMarkdown,
            baseName: body.baseName,
            tasks: body.tasks,
            calendarSummary: body.calendarSummary,
            calendarStart: body.calendarStart,
            calendarEnd: body.calendarEnd,
            calendarAttendeeOpenIds: body.calendarAttendeeOpenIds,
            ...(body.includeSlides ? { includeSlides: body.includeSlides } : {}),
          };
          return { status: 'ok', result: await service.goldenChain(opts) };
        }
      }
    } catch (err) {
      if (err instanceof LarkApiError) {
        reply.status(502);
        return {
          error: 'Lark API error',
          code: err.code,
          type: err.type,
          msg: err.message,
          ...(err.hint ? { hint: err.hint } : {}),
        };
      }
      if (err instanceof LarkCliUnavailableError) {
        reply.status(503);
        return { error: 'lark-cli unavailable', message: err.message };
      }
      if (err instanceof LarkCliProtocolError) {
        reply.status(500);
        return {
          error: 'lark-cli protocol error',
          message: err.message,
          ...(err.rawOutput ? { rawOutput: err.rawOutput } : {}),
        };
      }
      throw err;
    }
  });
}
