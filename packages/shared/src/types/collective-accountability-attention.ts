import { z } from 'zod';
import {
  collectiveConnectionCoordinatesSchema,
  collectiveEventIdSchema,
  collectiveHumanIdSchema,
  collectiveLocationSchema,
} from './collective.js';
import {
  collectiveRoadmapIdSchema,
  collectiveWorkAccountabilityRequestIdSchema,
  collectiveWorkIdSchema,
} from './collective-collaboration-identifiers.js';

export const COLLECTIVE_ACCOUNTABILITY_ATTENTION_PRODUCER_ID = 'f290.collective_work_accountability_request' as const;
const collectiveAccountabilityAttentionSnapshotSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

interface CollectiveAccountabilityAttentionIdentity {
  readonly serviceInstanceId: string;
  readonly collectiveId: string;
  readonly workId: string;
  readonly accountabilityRequestId: string;
}

interface CollectiveAccountabilityAttentionAction {
  readonly connectionId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly channelId: string;
  readonly roadmapId: string;
  readonly accountabilityRequestId: string;
}

export function collectiveAccountabilityAttentionSubjectRef(
  identity: CollectiveAccountabilityAttentionIdentity,
): string {
  return [
    'collective-accountability-request',
    identity.serviceInstanceId,
    identity.collectiveId,
    identity.workId,
    identity.accountabilityRequestId,
  ].join(':');
}

export function collectiveAccountabilityAttentionActionRef(action: CollectiveAccountabilityAttentionAction): string {
  const query = new URLSearchParams([
    ['target', 'accountability'],
    ['connectionId', action.connectionId],
    ['workId', action.workId],
    ['workRevision', String(action.workRevision)],
    ['channelId', action.channelId],
    ['roadmapId', action.roadmapId],
    ['accountabilityRequestId', action.accountabilityRequestId],
  ]);
  return `/collective?${query}`;
}

export const collectiveAccountabilityAttentionReadRequestSchema = collectiveConnectionCoordinatesSchema
  .extend({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(100),
    snapshot: collectiveAccountabilityAttentionSnapshotSchema.optional(),
  })
  .strict()
  .superRefine((read, context) => {
    if (read.offset > 0 && !read.snapshot) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshot'],
        message: 'Later accountability pages require the first page source snapshot',
      });
    }
  });

export const collectiveAccountabilityAttentionItemSchema = collectiveConnectionCoordinatesSchema
  .extend({
    producerId: z.literal(COLLECTIVE_ACCOUNTABILITY_ATTENTION_PRODUCER_ID),
    subjectRef: z.string().trim().min(1).max(800),
    workId: collectiveWorkIdSchema,
    workRevision: z.number().int().positive(),
    accountabilityRequestId: collectiveWorkAccountabilityRequestIdSchema,
    targetHumanId: collectiveHumanIdSchema,
    targetDisplayName: z.string().trim().min(1).max(120),
    requestedByHumanId: collectiveHumanIdSchema,
    requestedByDisplayName: z.string().trim().min(1).max(120),
    requestEventId: collectiveEventIdSchema,
    requestedAt: z.string().datetime(),
    status: z.literal('pending'),
    roadmapId: collectiveRoadmapIdSchema,
    projectTitle: z.string().trim().min(1).max(200),
    channelId: collectiveLocationSchema.shape.channelId,
    workSourceEventId: collectiveEventIdSchema,
    workTitle: z.string().trim().min(1).max(200),
    actionRef: z.string().trim().min(1).max(2000),
    expectedProducerRevision: z.number().int().positive(),
  })
  .strict()
  .superRefine((item, context) => {
    const subjectRef = collectiveAccountabilityAttentionSubjectRef(item);
    if (item.subjectRef !== subjectRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subjectRef'],
        message: 'Accountability attention subject does not match its durable request identity',
      });
    }
    if (item.expectedProducerRevision !== item.workRevision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedProducerRevision'],
        message: 'Expected producer revision must match the current Work revision',
      });
    }
    const actionRef = collectiveAccountabilityAttentionActionRef(item);
    if (item.actionRef !== actionRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actionRef'],
        message: 'Accountability attention action must name the exact current Project Task request',
      });
    }
  });

export const collectiveAccountabilityAttentionReadResponseSchema = z
  .object({
    identity: collectiveConnectionCoordinatesSchema
      .extend({
        authorizedHumanId: collectiveHumanIdSchema,
      })
      .strict(),
    items: z.array(collectiveAccountabilityAttentionItemSchema).max(100),
    page: z
      .object({
        offset: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(100),
        hasMore: z.boolean(),
        snapshot: collectiveAccountabilityAttentionSnapshotSchema,
        totalCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((read, context) => {
    if (read.items.length > read.page.limit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Accountability attention page exceeds its declared limit',
      });
    }
    if (read.page.offset + read.items.length > read.page.totalCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['page', 'totalCount'],
        message: 'Accountability page exceeds its frozen source size',
      });
    }
    for (const [index, item] of read.items.entries()) {
      const identityMatches =
        item.serviceInstanceId === read.identity.serviceInstanceId &&
        item.collectiveId === read.identity.collectiveId &&
        item.connectionId === read.identity.connectionId &&
        item.targetHumanId === read.identity.authorizedHumanId;
      if (!identityMatches) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index],
          message: 'Accountability attention item is outside the endpoint Human authority',
        });
      }
    }
  });

export type CollectiveAccountabilityAttentionReadRequest = z.infer<
  typeof collectiveAccountabilityAttentionReadRequestSchema
>;
export type CollectiveAccountabilityAttentionItem = z.infer<typeof collectiveAccountabilityAttentionItemSchema>;
export type CollectiveAccountabilityAttentionReadResponse = z.infer<
  typeof collectiveAccountabilityAttentionReadResponseSchema
>;
