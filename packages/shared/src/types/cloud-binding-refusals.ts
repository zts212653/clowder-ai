/**
 * F202 h3c-1 — why `PATCH /api/threads/:id/cloud-bindings` refused to change a thread's cloud binding.
 *
 * The endpoint sends one of these codes only from a check that runs before the binding is touched, so a
 * client may read a refusal carrying one of them as "nothing was written". Any other failure — a 5xx,
 * an answer that never arrived or cannot be read, a status without one of these codes — says nothing
 * about the binding: the write may have landed, and only reading the binding back settles it.
 *
 * Add a code here only for a check the endpoint makes before it writes.
 */
export const CLOUD_BINDING_REFUSALS = [
  'CLOUD_BINDING_AUTH_REQUIRED',
  'CLOUD_BINDING_RESERVED_IDENTITY',
  'CLOUD_BINDING_INVALID_BODY',
  'CLOUD_BINDING_THREAD_NOT_FOUND',
  'CLOUD_BINDING_SYSTEM_THREAD',
  'CLOUD_BINDING_NOT_OWNER',
] as const;

export type CloudBindingRefusal = (typeof CLOUD_BINDING_REFUSALS)[number];

export function isCloudBindingRefusal(value: unknown): value is CloudBindingRefusal {
  return typeof value === 'string' && (CLOUD_BINDING_REFUSALS as readonly string[]).includes(value);
}
