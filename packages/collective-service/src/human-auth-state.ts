import { z } from 'zod';

export const humanAuthBindingSchema = z
  .object({
    bindingId: z.string(),
    humanId: z.string(),
    provider: z.literal('github'),
    providerSubject: z.string(),
    handle: z.string(),
    avatarUrl: z.string().url().optional(),
    createdAt: z.string().datetime(),
    lastAuthenticatedAt: z.string().datetime(),
  })
  .strict();

export const humanAuthIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bind'), humanId: z.string() }).strict(),
  z.object({ kind: z.literal('accept_invite'), inviteId: z.string() }).strict(),
  z.object({ kind: z.literal('login') }).strict(),
]);

export const humanAuthAttemptSchema = z
  .object({
    attemptId: z.string(),
    provider: z.literal('github'),
    stateDigest: z.string(),
    intent: humanAuthIntentSchema,
    redirectUri: z.string().url(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    consumedAt: z.string().datetime().optional(),
  })
  .strict();

export const humanAuthCompletionSchema = z
  .object({
    completionId: z.string(),
    tokenDigest: z.string(),
    sessionId: z.string(),
    humanId: z.string(),
    collectiveId: z.string().optional(),
    expiresAt: z.string().datetime(),
    consumedAt: z.string().datetime().optional(),
  })
  .strict();

export interface HumanAuthBindingRecord {
  readonly bindingId: string;
  readonly humanId: string;
  readonly provider: 'github';
  readonly providerSubject: string;
  readonly handle: string;
  readonly avatarUrl?: string;
  readonly createdAt: string;
  readonly lastAuthenticatedAt: string;
}

export type HumanAuthIntent =
  | { readonly kind: 'bind'; readonly humanId: string }
  | { readonly kind: 'accept_invite'; readonly inviteId: string }
  | { readonly kind: 'login' };

export interface HumanAuthAttemptRecord {
  readonly attemptId: string;
  readonly provider: 'github';
  readonly stateDigest: string;
  readonly intent: HumanAuthIntent;
  readonly redirectUri: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

export interface HumanAuthCompletionRecord {
  readonly completionId: string;
  readonly tokenDigest: string;
  readonly sessionId: string;
  readonly humanId: string;
  readonly collectiveId?: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}
