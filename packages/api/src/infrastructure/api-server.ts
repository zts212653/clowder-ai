/**
 * The API's Fastify instance. Create it only through createApiServer so the
 * reply-ownership rule below covers every route and lifecycle hook.
 *
 * Rule: once a reply has started sending, nothing in the request lifecycle runs
 * after the function that sent it, and nothing sends again.
 *
 * Guards across this API send their own error (`requireSession`,
 * `requireCallbackAuth`, the callback-auth preHandler, ...) and the caller then
 * `return;`s. Fastify 4 decides "already sent" from `reply.sent`, which stays
 * false while the reply is still inside its preSerialization/onSend chain. So
 * when an async hook delays that chain, Fastify runs the next hook and the route
 * handler for a request it has already answered, and an async handler that
 * resolves undefined is sent again (lib/wrapThenable.js, lib/hooks.js). The second
 * writeHead throws ERR_HTTP_HEADERS_SENT from a promise callback and exits the
 * process. This surfaced in #5787 (plugin refusal), #6059 (approval receipts) and
 * as the 2026-11-04 runtime crash after #6490.
 *
 * Fastify's own answer is `return reply`: the function's promise then settles only
 * after the response finishes, so `reply.sent` is true when Fastify looks. The
 * wrappers below give every promise-returning route handler and lifecycle hook
 * that behaviour instead of asking each of the hundreds of guard callers to
 * remember it. Rejections are left to Fastify unchanged.
 *
 * Scope: route handlers and onRequest/preParsing/preValidation/preHandler hooks,
 * where the API's guards live. Error handlers, onError hooks and not-found
 * handlers are left to Fastify: every one the API registers today is synchronous,
 * which keeps the error reply inside the markers below. Making one async needs
 * this rule extended first.
 */
import { MAX_CONTENT_FILE_BASENAME_LENGTH } from '@cat-cafe/shared';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
  type RouteHandlerMethod,
} from 'fastify';

const LIFECYCLE_HOOKS = new Set(['onRequest', 'preParsing', 'preValidation', 'preHandler']);
const started = new WeakSet<FastifyRequest>();

function finished(reply: FastifyReply): Promise<undefined> {
  return new Promise((resolve) => {
    reply.then(
      () => resolve(undefined),
      (error: unknown) => {
        reply.log.warn({ err: error }, 'response stream failed after the reply started sending');
        resolve(undefined);
      },
    );
  });
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null)?.then === 'function';

/** Settles with `value`, but only after a reply that has started sending finishes. */
async function afterOwnedReply(request: FastifyRequest, reply: FastifyReply, value: unknown): Promise<unknown> {
  if (started.has(request)) await finished(reply);
  return value;
}

function ownHandler(handler: RouteHandlerMethod): RouteHandlerMethod {
  return function (this: FastifyInstance, request, reply) {
    const result: unknown = handler.call(this, request, reply);
    if (!isThenable(result)) return result;
    return Promise.resolve(result).then((value) => (started.has(request) ? finished(reply) : value));
  } as RouteHandlerMethod;
}

/**
 * Keeps the hook's arity and AsyncFunction kind, so Fastify's hook signature checks
 * still apply. Callback-style hooks return nothing and pass through untouched.
 */
function ownHook<T>(hook: T): T {
  if (typeof hook !== 'function') return hook;
  const owned =
    hook.constructor.name === 'AsyncFunction'
      ? async function (this: unknown, ...args: unknown[]) {
          const value: unknown = await Reflect.apply(hook, this, args);
          return afterOwnedReply(args[0] as FastifyRequest, args[1] as FastifyReply, value);
        }
      : function (this: unknown, ...args: unknown[]) {
          const result: unknown = Reflect.apply(hook, this, args);
          if (!isThenable(result)) return result;
          return Promise.resolve(result).then((value) =>
            afterOwnedReply(args[0] as FastifyRequest, args[1] as FastifyReply, value),
          );
        };
  Object.defineProperty(owned, 'length', { value: hook.length });
  return owned as T;
}

function ownRouteHooks(options: Record<string, unknown>): void {
  for (const name of LIFECYCLE_HOOKS) {
    const hooks = options[name];
    if (hooks) options[name] = Array.isArray(hooks) ? hooks.map(ownHook) : ownHook(hooks);
  }
}

function installReplyOwnership(app: FastifyInstance): void {
  // reply.send() enters one of these chains synchronously: objects go through
  // preSerialization, everything else (strings, buffers, streams, empty bodies)
  // straight to onSend; error replies reach them through the error handler.
  // Registered first, each marker runs before any async hook can delay the send.
  app.addHook('preSerialization', (request, _reply, payload, done) => {
    started.add(request);
    done(null, payload);
  });
  app.addHook('onSend', (request, _reply, payload, done) => {
    started.add(request);
    done(null, payload);
  });

  // Child scopes are Object.create(parent) instances, so they inherit this addHook.
  const addHook = app.addHook;
  app.addHook = function (this: FastifyInstance, name: string, hook: unknown) {
    return Reflect.apply(addHook, this, [name, LIFECYCLE_HOOKS.has(name) ? ownHook(hook) : hook]);
  } as unknown as FastifyInstance['addHook'];

  app.addHook('onRoute', (route) => {
    const options = route as unknown as Record<string, unknown>;
    ownRouteHooks(options);
    // @fastify/websocket handlers take (socket, request), not (request, reply).
    if (!options.websocket) route.handler = ownHandler(route.handler);
  });
}

export function createApiServer(options: FastifyServerOptions = {}): FastifyInstance {
  // find-my-way checks decoded parameter length. Its default 100 also shadows /uploads/*
  // when the GIF poster's :filename route exists, so match the existing basename contract.
  const app = Fastify({ ...options, maxParamLength: options.maxParamLength ?? MAX_CONTENT_FILE_BASENAME_LENGTH });
  installReplyOwnership(app);
  return app;
}
