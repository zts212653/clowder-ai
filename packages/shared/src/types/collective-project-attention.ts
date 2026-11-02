import { z } from 'zod';
import { collectiveConnectionCoordinatesSchema, collectiveHumanIdSchema } from './collective.js';
import { collectiveRoadmapIdSchema, collectiveWorkIdSchema } from './collective-collaboration-identifiers.js';

export const COLLECTIVE_PROJECT_ATTENTION_PRODUCER_ID = 'f290.collective_project_attention' as const;
const kindSchema = z.enum(['triage', 'date_suggestion', 'overdue']);
type Identity = {
  serviceInstanceId: string;
  collectiveId: string;
  roadmapId: string;
  targetHumanId: string;
  kind: z.infer<typeof kindSchema>;
  workId?: string;
};
type Action = {
  connectionId: string;
  channelId: string;
  roadmapId: string;
  kind: z.infer<typeof kindSchema>;
  workId?: string;
  workRevision?: number;
};
export function collectiveProjectAttentionSubjectRef(item: Identity) {
  return [
    'collective-project-attention',
    item.serviceInstanceId,
    item.collectiveId,
    item.roadmapId,
    item.kind,
    item.workId ?? 'project',
    item.targetHumanId,
  ].join(':');
}
export function collectiveProjectAttentionActionRef(item: Action) {
  const params = new URLSearchParams({
    target: 'project-attention',
    connectionId: item.connectionId,
    channelId: item.channelId,
    roadmapId: item.roadmapId,
    attention: item.kind,
  });
  if (item.workId && item.workRevision) {
    params.set('workId', item.workId);
    params.set('workRevision', String(item.workRevision));
  }
  return `/collective?${params}`;
}
export const collectiveProjectAttentionItemSchema = collectiveConnectionCoordinatesSchema
  .extend({
    producerId: z.literal(COLLECTIVE_PROJECT_ATTENTION_PRODUCER_ID),
    subjectRef: z.string().min(1).max(1000),
    kind: kindSchema,
    roadmapId: collectiveRoadmapIdSchema,
    projectTitle: z.string().min(1).max(200),
    channelId: z.string().trim().min(1).max(160),
    targetHumanId: collectiveHumanIdSchema,
    expectedProducerRevision: z.number().int().positive(),
    count: z.number().int().positive(),
    sinceAt: z.string().datetime(),
    workId: collectiveWorkIdSchema.optional(),
    workRevision: z.number().int().positive().optional(),
    workTitle: z.string().min(1).max(200).optional(),
    actionRef: z.string().min(1).max(2000),
  })
  .strict()
  .superRefine((item, context) => {
    if (
      item.subjectRef !== collectiveProjectAttentionSubjectRef(item) ||
      item.actionRef !== collectiveProjectAttentionActionRef(item) ||
      (item.kind !== 'triage' &&
        (!item.workId ||
          !item.workRevision ||
          !item.workTitle ||
          item.workRevision !== item.expectedProducerRevision)) ||
      (item.kind === 'triage' && (item.workId || item.workRevision || item.workTitle))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Project attention must retain its exact owner and source action',
      });
  });
export const collectiveProjectAttentionReadSchema = z
  .object({
    identity: collectiveConnectionCoordinatesSchema.extend({ authorizedHumanId: collectiveHumanIdSchema }).strict(),
    items: z.array(collectiveProjectAttentionItemSchema),
    reasons: z.array(z.string()),
  })
  .strict()
  .superRefine((read, context) => {
    for (const item of read.items)
      if (
        item.serviceInstanceId !== read.identity.serviceInstanceId ||
        item.collectiveId !== read.identity.collectiveId ||
        item.connectionId !== read.identity.connectionId ||
        item.targetHumanId !== read.identity.authorizedHumanId
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Project attention is outside the paired Human scope',
        });
  });
export type CollectiveProjectAttentionItem = z.infer<typeof collectiveProjectAttentionItemSchema>;
export type CollectiveProjectAttentionRead = z.infer<typeof collectiveProjectAttentionReadSchema>;
