import { collectiveLocationSchema, collectiveWorkLifecycleSchema, collectiveWorkStatusSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import type { ClientRequest } from './client-request.js';

const sourceSchema = z
  .object({
    eventId: z.string().trim().min(1),
    location: collectiveLocationSchema,
  })
  .strict();

const projectSchema = z
  .object({
    roadmapId: z.string().trim().min(1),
    title: z.string().trim().min(1).max(200),
    source: sourceSchema,
  })
  .strict();

const workSchema = z
  .object({
    workId: z.string().trim().min(1),
    title: z.string().trim().min(1).max(200),
    lifecycle: collectiveWorkLifecycleSchema,
    status: collectiveWorkStatusSchema,
    source: sourceSchema,
    projects: z.array(projectSchema).max(100),
  })
  .strict();

const artifactSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('artifact'),
      artifactId: z.string().trim().min(1),
      title: z.string().trim().min(1).max(200),
      mediaType: z.enum(['text/markdown', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']),
      ownerRevision: z.number().int().positive(),
      source: sourceSchema,
      workId: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('publication'),
      publicationId: z.string().trim().min(1),
      title: z.string().trim().min(1).max(200),
      source: sourceSchema,
      workId: z.string().trim().min(1).optional(),
    })
    .strict(),
]);

export const membershipLeaveReadinessSchema = z
  .object({
    serviceInstanceId: z.string().trim().min(1),
    collectiveId: z.string().trim().min(1),
    role: z.enum(['steward', 'member']),
    membershipRevision: z.number().int().positive(),
    governanceHandoffRequired: z.boolean(),
    canLeave: z.boolean(),
    responsibilities: z
      .object({
        works: z.array(workSchema),
        roadmaps: z.array(projectSchema),
        artifacts: z
          .object({
            items: z.array(artifactSchema),
            inaccessibleCount: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type MembershipLeaveReadiness = z.infer<typeof membershipLeaveReadinessSchema>;
export type LeaveReadinessSource = z.infer<typeof sourceSchema>;
export type LeaveReadinessProject = z.infer<typeof projectSchema>;
export type LeaveReadinessWork = z.infer<typeof workSchema>;
export type LeaveReadinessArtifact = z.infer<typeof artifactSchema>;

export async function readMembershipLeaveReadiness(request: ClientRequest, collectiveId: string) {
  const value = await request<unknown>(
    `/api/memberships/self-leave/readiness?collectiveId=${encodeURIComponent(collectiveId)}`,
  );
  return membershipLeaveReadinessSchema.parse(value);
}
