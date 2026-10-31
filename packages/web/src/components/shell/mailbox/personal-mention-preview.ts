import { ignoredItemCoordinateSchema, ignoredItemKey } from '@cat-cafe/shared';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';

export type MentionIgnorePeriod = 'today' | 'week' | 'earlier' | 'all';
const count = z.number().int().nonnegative().safe();
const requestSchema = z.object({
  threadId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  expectedRevision: count,
  preferenceCoordinate: ignoredItemCoordinateSchema.refine((coordinate) => coordinate.kind === 'mailbox'),
});
const schema = z
  .object({
    ownerUserId: z.string().trim().min(1),
    period: z.enum(['today', 'week', 'earlier', 'all']),
    coverage: z.object({ state: z.literal('complete') }),
    consistency: z.object({ state: z.literal('verified'), reasons: z.array(z.string()).length(0) }),
    readWindow: z.object({ startedAt: count, endedAt: count, consistency: z.literal('independent_source_reads') }),
    counts: z.object({ week: count, earlier: count }),
    requests: z.array(requestSchema),
    personalView: z.object({
      mode: z.literal('visible'),
      preferenceRevision: count,
      originalCount: count,
      visibleCount: count,
      ignoredCount: count,
    }),
  })
  .superRefine((value, context) => {
    const view = value.personalView;
    if (
      view.originalCount !== view.visibleCount + view.ignoredCount ||
      view.visibleCount !== value.requests.length ||
      value.readWindow.endedAt < value.readWindow.startedAt ||
      new Set(value.requests.map((request) => ignoredItemKey(request.preferenceCoordinate))).size !==
        value.requests.length
    ) {
      context.addIssue({ code: 'custom', message: 'Incomplete personal preview' });
    }
  });
export type PersonalMentionPreview = z.infer<typeof schema>;
export async function readPersonalMentionPreview(owner: string, period: MentionIgnorePeriod) {
  const path = `/api/concierge/work/mentions/handling-preview?period=${period}&personalView=visible`;
  const [session, response] = await Promise.all([
    apiFetch('/api/session'),
    apiFetch(path, undefined, { afterCurrentGet: true }),
  ]);
  if (!session.ok || !response.ok) throw new Error('unavailable');
  const principal: unknown = await session.json();
  const parsed = schema.safeParse(await response.json());
  if (
    !parsed.success ||
    parsed.data.ownerUserId !== owner ||
    parsed.data.period !== period ||
    !principal ||
    typeof principal !== 'object' ||
    !('userId' in principal) ||
    principal.userId !== owner
  )
    throw new Error('unavailable');
  return parsed.data;
}
/** Read times describe independent observations; only the exact set and owner/preference versions are compared. */
export function personalMentionPreviewKey(preview: PersonalMentionPreview) {
  const requests = preview.requests
    .map((request) =>
      JSON.stringify([
        request.threadId,
        request.messageId,
        request.expectedRevision,
        ignoredItemKey(request.preferenceCoordinate),
      ]),
    )
    .sort();
  return JSON.stringify([preview.ownerUserId, preview.period, preview.personalView.preferenceRevision, requests]);
}
