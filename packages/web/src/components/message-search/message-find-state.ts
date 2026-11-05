import { type MessageSearchResponse, messageSearchResponseSchema } from '@cat-cafe/shared';
import { z } from 'zod';

export type MessageFindDestination = 'memory' | 'works';

/** Find UI only. Source visibility and history geometry remain with their original owners. */
export interface MessageFindState {
  query: string;
  scope: 'thread' | 'global';
  sort: 'time' | 'relevance';
  scrollTop: number;
  status: 'idle' | 'ready' | 'error' | 'forbidden';
  response?: MessageSearchResponse;
}

export interface MessageFindContext {
  destination: MessageFindDestination;
  state: MessageFindState;
  workspaceOrigin?: { open: boolean; surfaceId: string | null; mode?: 'status' | 'workspace' | 'transcript' };
}

export const messageFindStateSchema = z.object({
  query: z.string().max(2000),
  scope: z.enum(['thread', 'global']),
  sort: z.enum(['time', 'relevance']),
  scrollTop: z.number().finite().min(0).max(100000000),
  status: z.enum(['idle', 'ready', 'error', 'forbidden']),
  response: messageSearchResponseSchema.optional(),
});

const findContextSchema = z.object({
  destination: z.enum(['memory', 'works']),
  state: messageFindStateSchema,
  workspaceOrigin: z
    .object({
      open: z.boolean(),
      surfaceId: z.string().min(1).max(2048).nullable(),
      mode: z.enum(['status', 'workspace', 'transcript']).optional(),
    })
    .optional(),
});

/** Browser UI metadata is bounded and never admits a source or grants decision authority. */
export function parseMessageFindContext(value: unknown): MessageFindContext | null {
  const parsed = findContextSchema.safeParse(value);
  if (!parsed.success || !parsed.data.state.query.trim() || JSON.stringify(parsed.data).length > 32000) return null;
  return parsed.data;
}
