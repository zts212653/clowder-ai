import { createHash } from 'node:crypto';
import { COLLECTIVE_ARTIFACT_VERSION_LIMIT } from '@cat-cafe/shared';
import { z } from 'zod';
import type {
  ContentActorV1,
  ContentOperationContextV1,
  ContentPublicationScopeV1,
  VideoProjectScopeV1,
} from './types.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value && !value.includes('\0'));
export const collectiveContentScopeSchema = z
  .object({
    kind: z.literal('collective-artifact'),
    serviceInstanceId: id,
    collectiveId: id,
    artifactId: id,
    contentRef: id,
    sourceEventId: id,
    publishedByHumanId: id,
  })
  .strict();
export type CollectiveContentScopeV1 = z.infer<typeof collectiveContentScopeSchema>;

export const collectiveContentOperationContextSchema = z
  .object({
    kind: z.enum(['collective-artifact:publish', 'collective-artifact:apply']),
    requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    actorHumanId: id,
    scopeRef: id,
    custodyRevision: z.number().int().positive().safe(),
    dispositionId: id,
  })
  .strict();
export type CollectiveContentOperationContextV1 = z.infer<typeof collectiveContentOperationContextSchema>;

export function collectiveContentScopeRef(scope: CollectiveContentScopeV1) {
  const parsed = collectiveContentScopeSchema.parse(scope);
  return `collective-owner:${createHash('sha256').update(JSON.stringify(parsed)).digest('hex')}`;
}

export function validateCollectiveContentScope(
  scope: CollectiveContentScopeV1 | undefined,
  input: {
    contentRef: string;
    mediaType: string;
    publicationScope?: ContentPublicationScopeV1;
    projectScope?: VideoProjectScopeV1;
    projectMediaScope?: unknown;
  },
) {
  if (!scope) {
    if (input.contentRef.startsWith('collective-content:')) throw new TypeError('Collective content scope is required');
    return;
  }
  collectiveContentScopeSchema.parse(scope);
  if (
    scope.contentRef !== input.contentRef ||
    input.mediaType !== 'text/markdown' ||
    input.publicationScope ||
    input.projectScope ||
    input.projectMediaScope
  )
    throw new TypeError('Collective content scope cannot include private publication or project authority');
}

export function validateCollectiveContentWrite(input: {
  scope: CollectiveContentScopeV1 | undefined;
  context: ContentOperationContextV1 | undefined;
  actor: ContentActorV1;
  kind: 'collective-artifact:publish' | 'collective-artifact:apply';
  bytes: Buffer;
  authorizeEffect?: () => Promise<void>;
}) {
  if (!input.scope) return;
  const context = collectiveContentOperationContextSchema.safeParse(input.context);
  if (
    !context.success ||
    context.data.kind !== input.kind ||
    context.data.scopeRef !== collectiveContentScopeRef(input.scope) ||
    context.data.actorHumanId !== input.actor.actorId ||
    input.actor.kind !== 'human' ||
    typeof input.authorizeEffect !== 'function' ||
    (input.kind === 'collective-artifact:publish' && input.scope.publishedByHumanId !== input.actor.actorId)
  )
    throw new TypeError('Collective content write requires current owner authority and exact operation context');
  if (input.bytes.byteLength > 65536) throw new TypeError('Collective Markdown exceeds the owner size limit');
  new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
}

export function requireCollectiveContentCapacity(scope: CollectiveContentScopeV1 | undefined, ownerRevision: number) {
  if (scope && ownerRevision > COLLECTIVE_ARTIFACT_VERSION_LIMIT)
    throw new RangeError('Shared work version limit reached; no owner effect was committed');
}
