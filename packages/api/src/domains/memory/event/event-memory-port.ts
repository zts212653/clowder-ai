import type { EventMemoryFilter, IEventMemoryStore, StoredEventMemoryLifecycle } from '../EventMemoryStore.js';

type EventWriteMethods = Pick<
  IEventMemoryStore,
  'markEvent' | 'correctEvent' | 'retireEvent' | 'hardForgetEvent' | 'getOwnerActionEvidence'
>;

/** Consumers need only owner-scoped events and the existing durable mutations. */
export type EventMemoryPort = {
  [Method in keyof EventWriteMethods]: (
    ...input: Parameters<EventWriteMethods[Method]>
  ) => ReturnType<EventWriteMethods[Method]> | Promise<ReturnType<EventWriteMethods[Method]>>;
} & {
  getEvent(
    eventId: string,
    ownerUserId: string,
  ): StoredEventMemoryLifecycle | null | Promise<StoredEventMemoryLifecycle | null>;
  listEvents(
    filter: EventMemoryFilter & { ownerUserId: string },
  ): StoredEventMemoryLifecycle[] | Promise<StoredEventMemoryLifecycle[]>;
  getByCoord(
    threadId: string,
    messageId: string,
    ownerUserId: string,
  ): StoredEventMemoryLifecycle[] | Promise<StoredEventMemoryLifecycle[]>;
};
