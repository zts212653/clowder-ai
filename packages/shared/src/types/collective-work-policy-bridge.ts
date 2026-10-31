import { z } from 'zod';
import { collectiveConnectionCoordinatesSchema, collectiveHumanIdSchema } from './collective.js';
import { collectiveWorkIdSchema } from './collective-collaboration.js';
import { collectiveWorkGrantScopeSchema } from './collective-work-policy.js';

const id = z.string().min(8).max(120);
const context = collectiveConnectionCoordinatesSchema.extend({
  bridgeId: id,
  contextId: id,
  contextRevision: z.number().int().positive(),
  humanId: collectiveHumanIdSchema,
});
const work = { workId: collectiveWorkIdSchema, workRevision: z.number().int().positive() };
export const collectiveHostWorkPolicyActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set_mode'), decisionMode: z.enum(['automatic', 'manual']) }).strict(),
  z
    .object({
      kind: z.literal('add_rule'),
      rule: collectiveWorkGrantScopeSchema.omit({ grantRef: true, sourceEventIds: true }),
    })
    .strict(),
  z.object({ kind: z.literal('allow_request'), ...work, permission: z.enum(['once', 'class']) }).strict(),
  z.object({ kind: z.literal('decline_request'), ...work }).strict(),
]);
export const collectiveHostWorkPolicyCommandSchema = context
  .extend({
    type: z.literal('collective:host-work-policy-command'),
    commandId: id,
    action: collectiveHostWorkPolicyActionSchema,
  })
  .strict();
const receipt = z
  .object({
    policyRevision: z.number().int().positive().optional(),
    grantRef: z.string().trim().min(1).max(240).optional(),
    grantRevision: z.number().int().positive().optional(),
    workRevision: z.number().int().positive().optional(),
  })
  .strict();
export const collectiveClientWorkPolicyReplySchema = context
  .extend({
    type: z.literal('collective:client-work-policy-reply'),
    commandId: id,
    result: z.discriminatedUnion('state', [
      z.object({ state: z.literal('registered'), receipt }).strict(),
      z
        .object({
          state: z.literal('failed'),
          code: z.enum(['permission_changed', 'unconfirmed']).optional(),
          message: z.string().min(1).max(300),
        })
        .strict(),
    ]),
  })
  .strict();
export const collectiveClientWorkPermissionRequestSchema = context
  .extend({
    type: z.literal('collective:client-work-permission-request'),
    ...work,
    sourceEventId: z.string().min(1).max(120),
    channelId: z.string().min(1).max(160),
    catId: z.string().min(1).max(120),
    requestKind: z.string().trim().min(1).max(240),
    title: z.string().trim().min(1).max(200),
  })
  .strict();
export type CollectiveHostWorkPolicyAction = z.infer<typeof collectiveHostWorkPolicyActionSchema>;
export type CollectiveHostWorkPolicyCommand = z.infer<typeof collectiveHostWorkPolicyCommandSchema>;
export type CollectiveWorkPolicyReceipt = z.infer<typeof receipt>;
export type CollectiveClientWorkPermissionRequest = z.infer<typeof collectiveClientWorkPermissionRequestSchema>;
