import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import { LiveCarrierUnavailableError } from '../domains/concierge/live/LiveCarrierOperationGate.js';
import type { LiveCompanionSessions } from '../domains/concierge/live/LiveCompanionSessions.js';
import { type CallbackActor, deriveCallbackActor } from './callback-scope-helpers.js';

export interface LiveTaskAuthority {
  isLive(actor: CallbackActor): Promise<boolean>;
  assertCurrent(actor: CallbackActor): Promise<void>;
  run<T>(actor: CallbackActor, operation: () => Promise<T>): Promise<T>;
}
/** The production callback adapter uses the canonical turn policy and the original Session authority. */
export function createLiveTaskAuthority(
  sessions: Pick<LiveCompanionSessions, 'assertTaskAuthority' | 'withCarrierOperation'>,
  turns: Pick<ITurnExecutionStore, 'get'>,
): LiveTaskAuthority {
  return {
    isLive: async (actor) => (await turns.get(actor.invocationId))?.queueCompletionPolicy === 'explicit_source',
    assertCurrent: sessions.assertTaskAuthority.bind(sessions),
    run: (actor, operation) => sessions.withCarrierOperation(actor, operation),
  };
}

/** Ordinary Task authority stays unchanged; Live mutations drain under the original carrier and recheck before writes. */
export function withLiveTaskAuthority(
  authority: LiveTaskAuthority | undefined,
  handler: (
    request: FastifyRequest,
    reply: FastifyReply,
    live: boolean,
    assertCurrent: () => Promise<void>,
  ) => Promise<unknown>,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const actor = request.callbackAuth ? deriveCallbackActor(request.callbackAuth) : undefined;
    const live = Boolean(actor && authority && (await authority.isLive(actor)));
    const assertCurrent = async () => {
      if (live) {
        if (!authority || !actor) throw new LiveCarrierUnavailableError();
        await authority.assertCurrent(actor);
      }
    };
    const operation = async () => {
      await assertCurrent();
      return handler(request, reply, live, assertCurrent);
    };
    return live && authority && actor ? authority.run(actor, operation) : operation();
  };
}
