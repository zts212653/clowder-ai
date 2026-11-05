import { z } from 'zod';

export const artifactListViewSchema = z.object({
  scope: z.enum(['thread', 'global']),
  filter: z.enum(['all', 'image', 'file', 'codepr', 'audio', 'video', 'widget']),
  query: z.string().max(4096),
  findSessionId: z.string().uuid().optional(),
  grouping: z.enum(['none', 'time', 'thread', 'cat']),
  catFilter: z.string().min(1).max(256).nullable(),
  collapsed: z.array(z.string().max(4096)).max(1000),
  viewport: z
    .object({
      scrollTop: z.number().finite().min(0).max(100000000),
      anchor: z
        .object({ key: z.string().min(1).max(4096), offset: z.number().finite().min(-10000000).max(10000000) })
        .optional(),
    })
    .optional(),
});
export type ArtifactListView = z.infer<typeof artifactListViewSchema>;
export const artifactListOriginSchema = z.object({
  kind: z.literal('artifact-list'),
  threadId: z.string().min(1).max(256),
  view: artifactListViewSchema,
});
export type ArtifactListOrigin = z.infer<typeof artifactListOriginSchema>;
