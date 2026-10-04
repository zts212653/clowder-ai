import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { CollectiveCurrentContext } from '../domains/plugin/builtin-runtime/collective-current-context.js';
import {
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackAuth,
} from './callback-auth-prehandler.js';

const currentSchema = z.object({}).strict();
const readSchema = z
  .object({
    contextRef: z.string().min(1).max(256),
    afterSequence: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
const replySchema = z
  .object({
    returnRef: z.string().min(1).max(256),
    replyOperationRef: z.string().min(1).max(256),
    body: z.string().trim().min(1).max(20000),
  })
  .strict();
const progressSchema = replySchema
  .omit({ replyOperationRef: true })
  .extend({ progressOperationRef: z.string().min(1).max(256) })
  .strict();
const interestSchema = z
  .object({
    contextRef: z.string().min(1).max(256),
    state: z.enum(['listen', 'withdraw']),
  })
  .strict();
const proposeWorkSchema = z
  .object({
    requestKind: z.string().trim().min(1).max(240).optional(),
    contextRef: z.string().min(1).max(256),
    title: z.string().trim().min(1).max(200).optional(),
    intendedOutcome: z.string().trim().min(1).max(32_000).optional(),
  })
  .strict();
const acceptWorkSchema = z
  .object({
    contextRef: z.string().min(1).max(256),
    grantRef: z.string().trim().min(1).max(240),
    grantRevision: z.number().int().positive(),
    requestKind: z.string().trim().min(1).max(240),
    title: z.string().trim().min(1).max(200),
    intendedOutcome: z.string().trim().min(1).max(32_000),
  })
  .strict();
const continueWorkSchema = z
  .object({
    contextRef: z.string().min(1).max(256),
    workRef: z.string().min(1).max(2000),
    kind: z.enum(['resume', 'revision']),
    grantRef: z.string().trim().min(1).max(240),
    grantRevision: z.number().int().positive(),
    requestKind: z.string().trim().min(1).max(240),
  })
  .strict();

export async function registerCollectiveParticipationCallbacks(
  app: FastifyInstance,
  options: {
    registry: CallbackAuthRegistry;
    context: CollectiveCurrentContext;
  },
) {
  await app.register(async (scope) => {
    registerCallbackAuthHook(scope, options.registry);
    registerCollectiveCallback(scope, 'current-context', currentSchema, (auth) => options.context.current(auth));
    registerCollectiveCallback(scope, 'read-context', readSchema, (auth, input) =>
      options.context.read(auth, input.contextRef, input.afterSequence, input.limit),
    );
    registerCollectiveCallback(scope, 'set-interest', interestSchema, (auth, input) =>
      options.context.setInterest(auth, input.contextRef, input.state),
    );
    registerCollectiveCallback(scope, 'propose-work', proposeWorkSchema, (auth, input) =>
      options.context.proposeWork(auth, input.contextRef, {
        ...(input.requestKind ? { requestKind: input.requestKind } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.intendedOutcome ? { intendedOutcome: input.intendedOutcome } : {}),
      }),
    );
    registerCollectiveCallback(scope, 'reply', replySchema, (auth, input) =>
      options.context.reply(auth, input.returnRef, input.replyOperationRef, input.body),
    );
    registerCollectiveCallback(scope, 'progress', progressSchema, (auth, input) =>
      options.context.progress(auth, input.returnRef, input.progressOperationRef, input.body),
    );
    registerCollectiveCallback(scope, 'accept-work', acceptWorkSchema, (auth, { contextRef, ...input }) =>
      options.context.acceptWork(auth, contextRef, input),
    );
    registerCollectiveCallback(scope, 'continue-work', continueWorkSchema, (auth, { contextRef, ...input }) =>
      options.context.continueWork(auth, contextRef, input),
    );
  });
}

type CallbackAuth = NonNullable<ReturnType<typeof requireCallbackAuth>>;

function registerCollectiveCallback<Input>(
  scope: FastifyInstance,
  name: string,
  schema: z.ZodType<Input>,
  handler: (auth: CallbackAuth, input: Input) => Promise<unknown>,
) {
  scope.post(`/api/callbacks/collective-${name}`, async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    try {
      return await handler(auth, schema.parse(request.body ?? {}));
    } catch (error) {
      return sendCollectiveError(reply, error);
    }
  });
}

function sendCollectiveError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError)
    return reply.status(400).send({ code: 'INVALID_COLLECTIVE_REQUEST', error: error.message });
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'RETURN_UNAVAILABLE';
  const forbidden = code === 'RETURN_REF_INVALID' || code.endsWith('_AUTHORITY_REQUIRED');
  const domainReason =
    /^(COLLECTIVE_|WORK_|RETURN_REF_|CONTEXT_|OWNER_ADMISSION_|PARTICIPATION_|AGENT_|CONNECTION_|CHANNEL_|SOURCE_|MEMBERSHIP_|HUMAN_)/.test(
      code,
    );
  return reply
    .status(forbidden ? 403 : 409)
    .send({ code, error: domainReason && error instanceof Error ? error.message : 'Collective source unavailable' });
}
