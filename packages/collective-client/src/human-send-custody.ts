import { type CollectiveHumanMessageRequest, collectiveHumanMessageRequestSchema } from '@cat-cafe/shared';

type BrowserStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/** Keeps one browser-owned operation per unresolved payload. Service is still the event owner. */
export function prepareHumanSend(
  storage: BrowserStore,
  namespace: string,
  payload: Omit<CollectiveHumanMessageRequest, 'clientEventId'>,
  createId: () => string = () => crypto.randomUUID(),
): CollectiveHumanMessageRequest {
  const key = `collective-pending:${namespace}`;
  const raw = storage.getItem(key);
  const pending = raw ? collectiveHumanMessageRequestSchema.array().parse(JSON.parse(raw)) : [];
  const normalized = collectiveHumanMessageRequestSchema.parse({ ...payload, clientEventId: 'comparison' });
  const previous = pending.find(
    (item) => JSON.stringify({ ...item, clientEventId: 'comparison' }) === JSON.stringify(normalized),
  );
  if (previous) return previous;
  const next = collectiveHumanMessageRequestSchema.parse({ ...payload, clientEventId: createId() });
  storage.setItem(key, JSON.stringify([...pending, next]));
  return next;
}
export function acknowledgeHumanSend(storage: BrowserStore, namespace: string, clientEventId: string) {
  const key = `collective-pending:${namespace}`;
  const raw = storage.getItem(key);
  if (!raw) return;
  const pending = collectiveHumanMessageRequestSchema
    .array()
    .parse(JSON.parse(raw))
    .filter((item) => item.clientEventId !== clientEventId);
  if (pending.length) storage.setItem(key, JSON.stringify(pending));
  else storage.removeItem(key);
}
export function collectiveClientNamespace(snapshot: {
  meta?: { serviceInstanceId: string };
  collective?: { collectiveId: string };
  me?: { human: { humanId: string } };
}) {
  return snapshot.meta && snapshot.collective && snapshot.me
    ? `${snapshot.meta.serviceInstanceId}:${snapshot.collective.collectiveId}:${snapshot.me.human.humanId}`
    : undefined;
}
