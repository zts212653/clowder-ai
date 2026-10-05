import { z } from 'zod';

export const artifactListViewSchema = z.object({
  scope: z.enum(['thread', 'global']),
  filter: z.enum(['all', 'image', 'file', 'codepr', 'audio', 'video', 'widget']),
  query: z.string().max(4096),
  grouping: z.enum(['none', 'time', 'thread', 'cat']),
  catFilter: z.string().min(1).max(256).nullable(),
  collapsed: z.array(z.string().max(4096)).max(1000),
});
export type ArtifactListView = z.infer<typeof artifactListViewSchema>;
export const artifactListOriginSchema = z.object({
  kind: z.literal('artifact-list'),
  threadId: z.string().min(1).max(256),
  view: artifactListViewSchema,
});
export type ArtifactListOrigin = z.infer<typeof artifactListOriginSchema>;
