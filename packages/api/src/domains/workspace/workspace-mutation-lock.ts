/** All F063 writers in this single API process share one boundary, including directory moves.
 * This serializes supported application writes; it cannot lock non-cooperating external editors.
 */
let pending: Promise<unknown> = Promise.resolve();

export function serializeWorkspaceMutation<T>(action: () => Promise<T>): Promise<T> {
  const next = pending.then(action, action);
  pending = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
