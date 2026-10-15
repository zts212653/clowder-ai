/** W5.P pinned SDK seam: the public interrupt() omits cancel_queued. */
interface PublicQuery {
  interrupt(): Promise<unknown>;
}
interface NativeRequestQuery extends PublicQuery {
  request(input: { subtype: 'interrupt'; cancel_queued: true }): Promise<{ response?: unknown }>;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function hasNativeQueuedCancel(query: PublicQuery): query is NativeRequestQuery {
  return typeof (query as unknown as Record<string, unknown>)['request'] === 'function';
}
export async function interruptIncludingQueued(
  query: PublicQuery,
  advertised: boolean,
): Promise<
  | {
      still_queued: string[];
      cancelled?: string[];
    }
  | undefined
> {
  if (!advertised) return (await query.interrupt()) as { still_queued: string[] } | undefined;
  if (!hasNativeQueuedCancel(query)) throw new Error('native_queued_cancel_unsupported');
  const wire = await query.request({ subtype: 'interrupt', cancel_queued: true });
  const receipt = wire.response;
  if (
    !record(receipt) ||
    !Array.isArray(receipt['still_queued']) ||
    receipt['still_queued'].length !== 0 ||
    !Array.isArray(receipt['cancelled']) ||
    !receipt['cancelled'].every((id) => typeof id === 'string')
  )
    throw new Error('native_queued_cancel_receipt_invalid');
  return { still_queued: [], cancelled: [...receipt['cancelled']] as string[] };
}
