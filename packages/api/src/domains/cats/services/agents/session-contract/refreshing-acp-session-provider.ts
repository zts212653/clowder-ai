import type { CatId } from '@cat-cafe/shared';
import { type AcpService, AcpSessionProvider } from './acp-session-provider.js';
import type * as Contract from './types.js';

const constructions = new WeakMap<object, Map<CatId, Promise<AcpService | null>>>();

/** Host-only asynchronous service construction, refreshed with the member/account configuration revision. */
export function createRefreshingAcpSessionProvider(input: {
  catId: CatId;
  scope: object;
  revision(): number;
  createService(): Promise<AcpService | null>;
}): AcpSessionProvider {
  let generation = -1;
  let pending: Promise<AcpService | null> | undefined;
  let current: AcpService | undefined;
  let bound: Contract.AgentSessionProvider | undefined;
  const preparations = new Set<Promise<AcpService | null>>();
  let disposal: Promise<void> | undefined;
  const get = () => {
    if (disposal) return Promise.reject(new Error('session_host_service_disposed'));
    const revision = input.revision();
    if (!pending || generation !== revision) {
      current = undefined;
      bound = undefined;
      const queue = constructions.get(input.scope) ?? new Map<CatId, Promise<AcpService | null>>();
      constructions.set(input.scope, queue);
      const building = (queue.get(input.catId) ?? Promise.resolve(null)).catch(() => null).then(input.createService);
      queue.set(input.catId, building);
      preparations.add(building);
      const clear = () => {
        if (queue.get(input.catId) === building) queue.delete(input.catId);
      };
      const failed = () => {
        // An older rejection must not evict a newer configuration's construction.
        if (pending === building) pending = undefined;
      };
      void building.then(
        (service) => {
          clear();
          if (!service) failed();
        },
        () => {
          clear();
          failed();
        },
      );
      pending = building;
      generation = revision;
      void building.then(
        (service) => {
          if (!disposal && pending === building && generation === input.revision()) current = service ?? undefined;
        },
        () => {},
      );
    }
    return pending;
  };
  return new AcpSessionProvider({
    catId: input.catId,
    disposeHostService() {
      disposal ??= Promise.resolve().then(async () => {
        current = undefined;
        bound = undefined;
        const results = await Promise.allSettled(
          [...preparations].map(async (preparing) => {
            const actual = await preparing.catch(() => null);
            await actual?.disposeHostService?.();
          }),
        );
        preparations.clear();
        const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, 'ACP Host preparation disposal failed');
      });
      return disposal;
    },
    async prepareHostService() {
      const service = await get();
      if (!service) throw new Error('Plugin ACP service unavailable');
      return service;
    },
    hostService: () => (!disposal && generation === input.revision() ? current : undefined),
    bindHostService(service) {
      const actual = current;
      const preparedGeneration = generation;
      if (disposal || !actual || actual !== service || preparedGeneration !== input.revision()) return;
      bound ??= new AcpSessionProvider({
        catId: input.catId,
        service: {
          async *invoke(prompt, options) {
            if (
              disposal ||
              generation !== preparedGeneration ||
              input.revision() !== preparedGeneration ||
              current !== actual
            )
              throw new Error('session_host_generation_changed');
            yield* actual.invoke(prompt, options);
          },
          async releaseSession(id) {
            await actual.releaseSession?.(id);
          },
        },
      });
      return bound;
    },
    service: {
      async *invoke(prompt, options) {
        const service = await get();
        if (!service) throw new Error('Plugin ACP service unavailable');
        yield* service.invoke(prompt, options);
      },
      async releaseSession(id) {
        await (await pending)?.releaseSession?.(id);
      },
    },
  });
}
