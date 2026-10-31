import { z } from 'zod';

type BrowserStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const pendingCommandSchema = z
  .object({
    fingerprint: z.string().min(1).max(64_000),
    requestId: z.string().min(1).max(200),
  })
  .strict();

export function prepareCollaborationCommand(
  storage: BrowserStore,
  namespace: string,
  payload: unknown,
  createId: () => string = () => crypto.randomUUID(),
): string {
  const key = `collective-collaboration-pending:${namespace}`;
  const raw = storage.getItem(key);
  const pending = raw ? pendingCommandSchema.array().parse(JSON.parse(raw)) : [];
  const fingerprint = JSON.stringify(payload);
  const existing = pending.find((item) => item.fingerprint === fingerprint);
  if (existing) return existing.requestId;
  const next = pendingCommandSchema.parse({ fingerprint, requestId: createId() });
  storage.setItem(key, JSON.stringify([...pending, next]));
  return next.requestId;
}

export function acknowledgeCollaborationCommand(storage: BrowserStore, namespace: string, requestId: string): void {
  const key = `collective-collaboration-pending:${namespace}`;
  const raw = storage.getItem(key);
  if (!raw) return;
  const pending = pendingCommandSchema
    .array()
    .parse(JSON.parse(raw))
    .filter((item) => item.requestId !== requestId);
  if (pending.length) storage.setItem(key, JSON.stringify(pending));
  else storage.removeItem(key);
}
