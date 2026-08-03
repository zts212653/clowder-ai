import type { UpdateInvocationInput } from '../../stores/ports/InvocationRecordStore.js';

interface InvocationUpdateStore {
  update(invocationId: string, update: UpdateInvocationInput): unknown | null | Promise<unknown | null>;
  get?(invocationId: string): { status?: string } | null | Promise<{ status?: string } | null>;
}

/** Terminal writers must not announce a transition that the durable store rejected. */
export async function requireInvocationRecordUpdate(input: {
  store: InvocationUpdateStore;
  invocationId: string;
  update: UpdateInvocationInput;
  writer: string;
}): Promise<void> {
  const updated = await input.store.update(input.invocationId, input.update);
  if (updated !== null) return;
  const current = await input.store.get?.(input.invocationId);
  throw new Error(
    `${input.writer} invocation update rejected: invocation=${input.invocationId} ` +
      `requested=${input.update.status ?? '<fields-only>'} current=${current?.status ?? '<missing>'}`,
  );
}
