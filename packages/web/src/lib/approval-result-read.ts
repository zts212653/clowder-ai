export interface ApprovalResultKey {
  owner: string;
  producer: string;
  proposalId: string;
}
export interface ApprovalResultPart<T = unknown> {
  value: T | undefined;
  reading: boolean;
  failed: boolean;
  observedAt: number | null;
}
export type ApprovalReadCause = 'read' | 'refresh' | 'facts';
type Loader = (signal: AbortSignal, cause?: ApprovalReadCause) => Promise<unknown>;
type Entry = {
  key: ApprovalResultKey;
  parts: Map<string, ApprovalResultPart>;
  listeners: Set<() => void>;
  jobs: Map<string, Promise<unknown>>;
  loaders: Map<string, Loader>;
  dirty: Set<string>;
  controllers: Set<AbortController>;
  partControllers: Map<string, AbortController>;
  generation: number;
  factsVersion: number;
  settledObservation: number;
  terminal: boolean;
  queued: boolean;
};
const fact = (part: string) => ['settled', 'native', 'verified-thread'].includes(part);
const admission = (part: string) => part.startsWith('receipt-admission:');
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** One result identity. Canonical facts are observed atomically; derived views never become independent result authority. */
export function createApprovalResultRead() {
  const entries = new Map<string, Entry>();
  let observation = 0;
  const id = (key: ApprovalResultKey) => JSON.stringify([key.owner, key.producer, key.proposalId]);
  const entry = (key: ApprovalResultKey) => {
    let current = entries.get(id(key));
    if (!current) {
      current = {
        key,
        parts: new Map(),
        listeners: new Set(),
        jobs: new Map(),
        loaders: new Map(),
        dirty: new Set(),
        controllers: new Set(),
        partControllers: new Map(),
        generation: 0,
        factsVersion: 0,
        settledObservation: 0,
        terminal: false,
        queued: false,
      };
      entries.set(id(key), current);
    }
    return current;
  };
  const notify = (current: Entry) => {
    for (const listener of current.listeners) listener();
  };
  const empty: ApprovalResultPart = { value: undefined, reading: false, failed: false, observedAt: null };
  const snapshot = <T>(key: ApprovalResultKey, part: string) =>
    (entry(key).parts.get(part) ?? empty) as ApprovalResultPart<T>;
  const store = (current: Entry, values: Record<string, unknown>) => {
    const names = new Set(Object.keys(values));
    const changed = [...names].some((part) => fact(part) && !same(current.parts.get(part)?.value, values[part]));
    if (changed) {
      current.factsVersion++;
      for (const [part, old] of current.parts) {
        if (names.has(part) || admission(part)) continue;
        // A native body is private detail/preflight evidence. A newer canonical result withdraws its older claim.
        if (part === 'settled' || (part === 'native' && !names.has('settled'))) continue;
        current.dirty.add(part);
        if (part === 'native') {
          current.partControllers.get(part)?.abort();
          current.jobs.delete(part);
          current.parts.set(part, { ...old, reading: false });
        }
      }
    }
    for (const [part, value] of Object.entries(values)) {
      current.dirty.delete(part);
      current.parts.set(part, { value, reading: false, failed: false, observedAt: Date.now() });
    }
    notify(current);
  };
  const read = <T>(
    key: ApprovalResultKey,
    part: string,
    load: (signal: AbortSignal, cause?: ApprovalReadCause) => Promise<T>,
    force = false,
    cause: ApprovalReadCause = 'read',
  ): Promise<T> => {
    const current = entry(key),
      previous = snapshot<T>(key, part);
    current.loaders.set(part, load);
    const pending = current.jobs.get(part);
    if (pending && !force) return pending as Promise<T>;
    if (previous.value !== undefined && !force && !current.dirty.has(part)) return Promise.resolve(previous.value);
    const controller = new AbortController(),
      generation = current.generation,
      version = current.factsVersion;
    current.controllers.add(controller);
    current.partControllers.set(part, controller);
    current.dirty.delete(part);
    current.parts.set(part, { ...previous, reading: true, failed: false });
    notify(current);
    const task = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return load(controller.signal, cause);
      })
      .then(
        (value) => {
          if (controller.signal.aborted || generation !== current.generation || current.jobs.get(part) !== task)
            throw new DOMException('Stale approval read', 'AbortError');
          // A source read may itself discover newer facts. Re-derive under that version, rather than install its old projection.
          if (!fact(part) && !admission(part) && version !== current.factsVersion)
            return read(key, part, load, true, 'facts');
          store(current, { [part]: value });
          return value;
        },
        (error) => {
          if (
            !controller.signal.aborted &&
            generation === current.generation &&
            current.jobs.get(part) === task &&
            !fact(part) &&
            !admission(part) &&
            version !== current.factsVersion
          )
            return read(key, part, load, true, 'facts');
          if (!controller.signal.aborted && generation === current.generation && current.jobs.get(part) === task) {
            current.parts.set(part, { ...previous, reading: false, failed: true });
            notify(current);
          }
          throw error;
        },
      )
      .finally(() => {
        current.controllers.delete(controller);
        if (current.partControllers.get(part) === controller) current.partControllers.delete(part);
        if (current.jobs.get(part) === task) current.jobs.delete(part);
      });
    current.jobs.set(part, task);
    return task;
  };
  const queue = (current: Entry) => {
    if (current.queued) return;
    current.queued = true;
    queueMicrotask(() => {
      current.queued = false;
      if (!current.listeners.size) return;
      for (const part of [...current.dirty].sort((a, b) => Number(fact(b)) - Number(fact(a)))) {
        if (admission(part)) continue;
        const load = current.loaders.get(part);
        if (load) void read(current.key, part, load, true, fact(part) ? 'refresh' : 'facts').catch(() => {});
      }
    });
  };
  const clear = (current: Entry) => {
    current.generation++;
    current.factsVersion++;
    for (const controller of current.controllers) controller.abort();
    current.controllers.clear();
    current.partControllers.clear();
    current.jobs.clear();
    current.parts.clear();
    current.dirty.clear();
    current.loaders.clear();
    current.terminal = false;
    notify(current);
  };
  return {
    snapshot,
    read,
    beginObservation: () => ++observation,
    factsVersion: (key: ApprovalResultKey) => entry(key).factsVersion,
    isCurrent(key: ApprovalResultKey, part: string) {
      const current = entry(key);
      return current.parts.has(part) && !current.dirty.has(part) && !current.jobs.has(part);
    },
    isStale(key: ApprovalResultKey, part: string) {
      return entry(key).dirty.has(part);
    },
    subscribe(key: ApprovalResultKey, listener: () => void) {
      const current = entry(key);
      current.listeners.add(listener);
      return () => {
        current.listeners.delete(listener);
      };
    },
    seed<T>(key: ApprovalResultKey, part: string, value: T) {
      const current = entry(key);
      current.partControllers.get(part)?.abort();
      current.jobs.delete(part);
      store(current, { [part]: value });
    },
    seedFacts(key: ApprovalResultKey, values: Record<string, unknown>, observed?: number) {
      const current = entry(key);
      if ('settled' in values) {
        if (observed !== undefined && observed < current.settledObservation) return false;
        current.settledObservation = observed ?? ++observation;
      }
      for (const part of Object.keys(values)) {
        current.partControllers.get(part)?.abort();
        current.jobs.delete(part);
      }
      store(current, values);
      return true;
    },
    terminal(key: ApprovalResultKey) {
      entry(key).terminal = true;
    },
    invalidateParts(key: ApprovalResultKey, parts: string[]) {
      const current = entry(key);
      for (const part of parts) {
        if (!current.parts.has(part)) continue;
        current.dirty.add(part);
        current.partControllers.get(part)?.abort();
        current.jobs.delete(part);
      }
      queue(current);
    },
    invalidate(target: { proposalId?: string; producer?: string } = {}) {
      for (const current of entries.values()) {
        if (
          (target.proposalId && target.proposalId !== current.key.proposalId) ||
          (target.producer && target.producer !== current.key.producer) ||
          (!target.proposalId && current.terminal)
        )
          continue;
        current.generation++;
        for (const controller of current.controllers) controller.abort();
        current.jobs.clear();
        for (const part of current.parts.keys()) current.dirty.add(part);
        queue(current);
      }
    },
    clearOwner(owner: string) {
      for (const current of entries.values()) if (current.key.owner === owner) clear(current);
    },
    clear() {
      for (const current of entries.values()) clear(current);
    },
  };
}
export const approvalResultRead = createApprovalResultRead();
