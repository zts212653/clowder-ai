import type { AgentService } from '../../../../types.js';
import type { AcpProcessPool } from '../AcpProcessPool.js';
import { trackAcpPoolRetirement } from './acp-pool-retirement-registry.js';

interface PoolOwnership {
  count: number;
  externalOwner: boolean;
  activeWork: number;
  retiring: boolean;
  drain?: () => Promise<void> | void;
  closing?: Promise<void>;
  workDrained?: { promise: Promise<void>; resolve: () => void };
}
const owners = new WeakMap<object, PoolOwnership>();
export interface AcpServicePoolLease {
  release(): Promise<void>;
  beginWork(): void;
  endWork(): Promise<void>;
}
export interface AcpServicePoolRetirement {
  completion: Promise<void>;
  deferredForActiveWork: boolean;
}

function closeAfterWork(pool: { closeAll(): Promise<void> }, state: PoolOwnership): Promise<void> {
  if (!state.retiring || state.activeWork > 0) return Promise.resolve();
  state.workDrained?.resolve();
  return (state.closing ??= Promise.resolve(state.drain ? state.drain() : pool.closeAll()));
}

/** Stale registry entries can retire while an already-running service finishes. */
export function retireAcpServicePool(
  pool: { closeAll(): Promise<void> },
  drain?: () => Promise<void> | void,
): AcpServicePoolRetirement {
  const state = owners.get(pool);
  if (!state) return { completion: Promise.resolve(drain ? drain() : pool.closeAll()), deferredForActiveWork: false };
  // Preserve factory replacement's native drain policy, but defer it until an
  // already-pinned invocation has performed its first acquire and finished.
  // Final owned-service disposal upgrades drain to complete close.
  if (!drain && state.drain) state.closing = undefined;
  if (!state.retiring || !drain) state.drain = drain;
  state.retiring = true;
  if (state.activeWork > 0) {
    state.workDrained ??= (() => {
      let resolve = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    return {
      completion: state.workDrained.promise.then(() => closeAfterWork(pool, state)),
      deferredForActiveWork: true,
    };
  }
  return { completion: closeAfterWork(pool, state), deferredForActiveWork: false };
}

/** One service preparation owns one lease, independently of process/session leases. */
export function retainAcpServicePool(
  registry: Map<string, AcpProcessPool>,
  profileId: string,
  pool: AcpProcessPool,
  created: boolean,
): AcpServicePoolLease {
  const state = owners.get(pool) ?? { count: 0, externalOwner: !created, activeWork: 0, retiring: false };
  owners.set(pool, state);
  state.count++;
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      state.count--;
      if (state.count > 0 || state.externalOwner) return;
      const retirement = retireAcpServicePool(pool);
      trackAcpPoolRetirement(registry, profileId, retirement.completion);
      // A replacement generation may already own this registry coordinate.
      if (registry.get(profileId) === pool) registry.delete(profileId);
      // Releasing ownership must not deadlock an already-pinned invocation during registry refresh.
      if (!retirement.deferredForActiveWork) await retirement.completion;
    },
    beginWork() {
      if (released || state.retiring) throw new Error('ACP service ownership retired');
      state.activeWork++;
    },
    async endWork() {
      state.activeWork--;
      await closeAfterWork(pool, state);
    },
  };
}

/** Pin before Host admission; every view delegates capabilities to the same concrete service. */
export function bindAcpServicePoolLease<T extends AgentService>(
  service: T,
  lease: AcpServicePoolLease,
): T & {
  disposeHostService(): Promise<void>;
} {
  const invoke = service.invoke.bind(service);
  const prepare = (): AgentService => {
    lease.beginWork();
    let held = true;
    let disposed = false;
    let streams = 0;
    const releasePin = async () => {
      if (!held) return;
      held = false;
      await lease.endWork();
    };
    const releaseInvocation = async () => {
      disposed = true;
      if (!streams) await releasePin();
    };
    const invokePinned: AgentService['invoke'] = (prompt, options) => {
      if (disposed) throw new Error('ACP invocation ownership released');
      // Sequential retries use this captured service, never a replacement generation.
      if (!held) {
        lease.beginWork();
        held = true;
      }
      streams++;
      let finished = false;
      const finish = async () => {
        if (finished) return;
        finished = true;
        streams--;
        if (!streams) await releasePin();
      };
      const stream = (async function* () {
        try {
          yield* invoke(prompt, options);
        } finally {
          await finish();
        }
      })();
      // AsyncGenerator.return/throw before the first next never enters its finally.
      const close = stream.return.bind(stream);
      stream.return = async (value) => {
        try {
          return await close(value);
        } finally {
          await finish();
        }
      };
      const fail = stream.throw.bind(stream);
      stream.throw = async (error) => {
        try {
          return await fail(error);
        } finally {
          await finish();
        }
      };
      return stream;
    };
    const repeat = () => view;
    const view: AgentService = new Proxy(service, {
      get(target, property) {
        if (property === 'forInvocation') return repeat;
        if (property === 'releaseInvocation') return releaseInvocation;
        if (property === 'invoke') return invokePinned;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set() {
        throw new TypeError('Pinned ACP invocation is immutable');
      },
    });
    return view;
  };
  service.invoke = (prompt, options) => prepare().invoke(prompt, options);
  return Object.assign(service, { forInvocation: prepare, disposeHostService: () => lease.release() });
}
