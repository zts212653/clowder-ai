import {
  deploymentDefaults,
  dotAskArguments,
  dotImageArguments as imageArguments,
  dotReplyArguments as replyArguments,
} from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DotConnectionService } from '../domains/cats/services/cloud-bridge/dot/DotConnectionService.js';
import type { DotReturnService } from '../domains/cats/services/cloud-bridge/dot/DotReturnService.js';
import {
  DOT_EVENT_DEFINITION,
  DOT_TOOLS,
  dotEventRefSchema,
  dotSubscriptionArguments,
} from '../domains/cats/services/cloud-bridge/dot/dot-mcp-contract.js';
import { dotEventValidationDiagnostics } from './dot-event-validation.js';

const rpcSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string().max(128), z.number(), z.null()]).optional(),
    method: z.string().max(100),
    params: z.unknown().optional(),
  })
  .strict();
const delivery = z.object({ mode: z.literal('webhook'), url: z.string().url().max(2048) }).strict();
const subscription = z
  .object({
    name: z.literal('dot.summoned'),
    arguments: dotSubscriptionArguments,
    delivery: delivery.extend({ secret: z.string().max(256) }),
    cursor: z.null().optional(),
    ttlMs: z.number().int().positive().nullable().optional(),
    // Protocol metadata is never an author, owner, or permission selector.
    _meta: z.record(z.unknown()).optional(),
    // dot has no replay; the protocol says to ignore this bound with cursor:null.
    maxAgeMs: z.number().int().nonnegative().optional(),
  })
  .strict();
const unsubscribe = z
  .object({
    name: z.literal('dot.summoned'),
    arguments: dotSubscriptionArguments,
    delivery,
    cursor: z.null().optional(),
    _meta: z.record(z.unknown()).optional(),
  })
  .strict();
const toolCall = z
  .object({ name: z.string(), arguments: z.unknown(), _meta: z.record(z.unknown()).optional() })
  .strict();

export function registerDotMcpRoutes(
  app: FastifyInstance,
  options: {
    connection: DotConnectionService;
    returns: DotReturnService;
    ask?: (secret: string, input: z.infer<typeof dotAskArguments>) => Promise<unknown>;
    publishImage: (secret: string, input: z.infer<typeof imageArguments>) => Promise<unknown>;
  },
) {
  for (const shared of [false, true]) {
    app.post(
      `/api/plugins/chatgpt-dot/${shared ? 'shared-mcp' : 'mcp'}`,
      { bodyLimit: 15 * 1024 * 1024 },
      async (request, reply) => {
        reply.header('cache-control', 'no-store');
        let secret = shared
          ? String(request.headers['x-agent-key-secret'] ?? '')
          : /^Bearer ([a-f0-9]{64})$/.exec(String(request.headers.authorization ?? ''))?.[1];
        if (
          shared &&
          (request.headers['x-invocation-id'] || request.headers['x-callback-token'] || request.headers.authorization)
        )
          return reply.code(403).send({ error: 'shared_connection_rejected' });
        if (!secret) return reply.code(401).send({ error: 'dot_authentication_required' });
        try {
          if (shared) await options.connection.verifySharedPrincipal(secret);
          else await options.connection.authenticate(secret);
        } catch {
          return reply.code(403).send({ error: 'dot_credential_rejected' });
        }
        const parsed = rpcSchema.safeParse(request.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
        const { id, method, params } = parsed.data;
        if (id === undefined) {
          if (method === 'notifications/initialized') return reply.code(202).send();
          return reply.code(400).send({ error: 'request_id_required' });
        }
        const response = (result: Record<string, unknown>) => ({
          jsonrpc: '2.0',
          id,
          result: { resultType: 'complete', ...result },
        });
        try {
          if (method === 'server/discover')
            return response({
              resultType: 'complete',
              supportedVersions: ['2026-07-28'],
              capabilities: { tools: {}, events: {} },
            });
          if (method === 'initialize')
            return response({
              protocolVersion: '2026-07-28',
              capabilities: { tools: {}, events: {} },
              serverInfo: { name: `${deploymentDefaults.brand.displayName} dot`, version: '0.1.0' },
            });
          if (method === 'ping') return response({});
          if (method === 'events/list') return response({ events: [DOT_EVENT_DEFINITION] });
          if (method === 'tools/list') return response({ tools: DOT_TOOLS });
          if (shared) secret = (await options.connection.authenticateSharedConnection(secret)).credentialSecret;
          if (method === 'events/subscribe') {
            const parsedSubscription = subscription.safeParse(params);
            if (!parsedSubscription.success) {
              request.log.warn(
                {
                  dotMethod: method,
                  dotFailureReason: 'invalid_parameters',
                  ...dotEventValidationDiagnostics(parsedSubscription.error),
                },
                'dot_subscription_failed',
              );
              return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid parameters' } };
            }
            const input = parsedSubscription.data;
            request.log.info(
              { dotMethod: method, callbackHostname: new URL(input.delivery.url).hostname },
              'dot_subscription_received',
            );
            return response(
              await options.connection.subscribe(secret, {
                attemptId: input.arguments.attempt_id,
                pairingCode: input.arguments.pairing_code,
                url: input.delivery.url,
                secret: input.delivery.secret,
                ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
              }),
            );
          }
          if (method === 'events/unsubscribe') {
            const input = unsubscribe.parse(params);
            const state = await options.connection.authenticate(secret);
            if (state.pairingCode !== input.arguments.pairing_code) throw new Error('dot_subscription_mismatch');
            return response(
              await options.connection.unsubscribe(secret, input.delivery.url, input.arguments.attempt_id),
            );
          }
          if (method === 'tools/call') {
            const input = toolCall.parse(params);
            let result: unknown;
            if (input.name === 'cat_cafe_dot_read_source')
              result = await options.returns.read(secret, dotEventRefSchema.parse(input.arguments).event_id);
            else if (input.name === 'cat_cafe_dot_reply') {
              const args = replyArguments.parse(input.arguments);
              result = await options.returns.reply(secret, args.event_id, args.content);
            } else if (input.name === 'cat_cafe_dot_publish_image')
              result = await options.publishImage(secret, imageArguments.parse(input.arguments));
            else if (input.name === 'cat_cafe_dot_ask') {
              if (!options.ask) throw new Error('dot_ask_unavailable');
              result = await options.ask(secret, dotAskArguments.parse(input.arguments));
            } else return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown dot tool' } };
            return response({
              content: [{ type: 'text', text: JSON.stringify(result) }],
              structuredContent: result,
              isError: false,
            });
          }
          return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
        } catch (error) {
          if (error instanceof z.ZodError) {
            if (method === 'events/subscribe')
              request.log.warn(
                { dotMethod: method, dotPhase: 'connection_or_service', dotFailureReason: 'invalid_parameters' },
                'dot_subscription_failed',
              );
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid parameters' } };
          }
          const reason =
            error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'dot_operation_unavailable';
          if (method === 'events/subscribe') {
            const diagnosticReason =
              error instanceof Error && error.message.startsWith('URL resolves to private/reserved IP range:')
                ? 'callback_non_public_address'
                : reason;
            const dotFailureCode =
              error instanceof Error &&
              'code' in error &&
              typeof error.code === 'string' &&
              /^[A-Z][A-Z0-9_]{2,39}$/.test(error.code)
                ? error.code
                : undefined;
            request.log.warn(
              { dotMethod: method, dotFailureReason: diagnosticReason, dotFailureCode },
              'dot_subscription_failed',
            );
          }
          const callback = /challenge|callback/.test(reason);
          return {
            jsonrpc: '2.0',
            id,
            error: { code: callback ? -32015 : -32000, message: 'Dot operation failed', data: { reason } },
          };
        }
      },
    );
  }
}
