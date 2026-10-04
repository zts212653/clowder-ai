import { z } from 'zod';

export const routeReceiptSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local_echo') }).strict(),
  z.object({ kind: z.literal('not_local') }).strict(),
  z
    .object({
      kind: z.literal('thread_message'),
      threadId: z.string(),
      messageId: z.string(),
      catId: z.string().optional(),
      attention: z
        .union([
          z
            .object({
              request: z.literal('channel_listening'),
              state: z.literal('failed'),
              reason: z.enum(['ROUTE_CAT_UNAVAILABLE', 'ROUTE_CAT_NOT_IN_THREAD']),
            })
            .strict(),
          z.object({ request: z.literal('response_requested'), state: z.literal('unclaimed') }).strict(),
          z
            .object({
              request: z.literal('response_requested'),
              state: z.literal('wake_queued'),
              catId: z.string(),
              interestRevision: z.number().int().positive(),
            })
            .strict(),
        ])
        .optional(),
    })
    .strict(),
]);

export type ConnectorRouteReceipt =
  | { readonly kind: 'local_echo' }
  | { readonly kind: 'not_local' }
  | {
      readonly kind: 'thread_message';
      readonly threadId: string;
      readonly messageId: string;
      readonly catId?: string;
      readonly attention?:
        | {
            readonly request: 'channel_listening';
            readonly state: 'failed';
            readonly reason: 'ROUTE_CAT_UNAVAILABLE' | 'ROUTE_CAT_NOT_IN_THREAD';
          }
        | { readonly request: 'response_requested'; readonly state: 'unclaimed' }
        | {
            readonly request: 'response_requested';
            readonly state: 'wake_queued';
            readonly catId: string;
            readonly interestRevision: number;
          };
    };
