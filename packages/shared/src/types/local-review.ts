import { z } from 'zod';

const FULL_GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FEATURE_SOURCE_REF = /^docs\/features\/F\d{3,}[-A-Za-z0-9._/]*\.md$/;
const MESSAGE_SOURCE_REF = /^(thread_[A-Za-z0-9]+)#([A-Za-z0-9_-]+)$/;
const REVIEW_SUBJECT_REF = /^[a-z][a-z0-9_-]*:[^\s]{1,220}$/;

export const localReviewVerdictSchema = z.enum(['approved', 'changes_requested', 'commented']);
export type LocalReviewVerdict = z.infer<typeof localReviewVerdictSchema>;

export const localReviewGitRevisionSchema = z.string().regex(FULL_GIT_REVISION);

export const reviewSubjectRefSchema = z
  .string()
  .regex(REVIEW_SUBJECT_REF)
  .describe('Stable local-review subject, for example pr:owner/repo#123.');

export const acceptedSourceRefSchema = z
  .string()
  .min(1)
  .max(300)
  .describe('Accepted feature-document path or immutable threadId#messageId source.');

export const acceptedRevisionSchema = z
  .string()
  .min(1)
  .max(200)
  .describe('Exact feature Git OID or immutable source message id.');

export interface LocalReviewAcceptedSourceAnchor {
  readonly reviewSubjectRef: string;
  readonly acceptedSourceRef: string;
  readonly acceptedRevision: string;
}

export function isValidReviewSubjectRef(value: string): boolean {
  return REVIEW_SUBJECT_REF.test(value);
}

export function isValidAcceptedSource(ref: string, revision: string): boolean {
  if (FEATURE_SOURCE_REF.test(ref)) return FULL_GIT_REVISION.test(revision);
  const message = MESSAGE_SOURCE_REF.exec(ref);
  return message !== null && revision === message[2];
}
