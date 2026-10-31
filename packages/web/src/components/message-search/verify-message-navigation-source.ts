import type { MessageNavigationReference } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';

type Admission = { status: 'available'; updated: boolean } | { status: 'forbidden' | 'unavailable' };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Cached coordinates and revision hashes never substitute for a fresh server read admission. */
export async function verifyMessageNavigationSource(
  ref: MessageNavigationReference,
  signal: AbortSignal,
): Promise<Admission> {
  const params = new URLSearchParams({ threadId: ref.threadId });
  if (ref.messageId) params.set('messageId', ref.messageId);
  if (ref.contentRevision) params.set('contentRevision', ref.contentRevision);
  try {
    const response = await apiFetch(`/api/evidence/navigation-source?${params}`, { signal });
    if (!response.ok)
      return { status: response.status === 401 || response.status === 403 ? 'forbidden' : 'unavailable' };
    const body: unknown = await response.json();
    if (
      !object(body) ||
      body.status !== 'available' ||
      typeof body.updated !== 'boolean' ||
      !object(body.target) ||
      body.target.threadId !== ref.threadId ||
      body.target.messageId !== ref.messageId ||
      (ref.messageId && (typeof body.target.contentRevision !== 'string' || !body.target.contentRevision))
    )
      return { status: 'unavailable' };
    return { status: 'available', updated: body.updated };
  } catch {
    return { status: 'unavailable' };
  }
}
