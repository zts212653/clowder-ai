import { z } from 'zod';
import { deploymentDefaults } from '../deployment-defaults.js';

export const ACTION_SUBJECT_REF_DESCRIPTION =
  `subjectRef must use pr:<owner>/<repo>#<positive-number> (for example pr:${deploymentDefaults.repositoryFullName}#2943) ` +
  'or subject:<namespace>:<opaque-id>. GitHub URL forms and SHA suffixes such as github:owner/repo#2943@abc123 are invalid.';

export const TASK_ACTION_SUBJECT_REF_DESCRIPTION =
  'Implementation needs subject:task:<taskId> from the existing Task.id covering this work and authorized target thread/cat. ' +
  'Asset/artifact IDs belong in content or artifact references; changing their prefix does not create Task authority.';

export const ACTION_SUBJECT_REF_MAX_LENGTH = 240;
// biome-ignore lint/suspicious/noControlCharactersInRegex: U+001F is the identity-key delimiter and must be excluded explicitly.
export const ACTION_SUBJECT_REF_PATTERN =
  /^(?:pr:[^/\s\x1f]+\/[^#\s\x1f]+#[1-9]\d*|subject:[a-z][a-z0-9_-]{0,63}:[^\s\x1f]{1,200})$/i;

/** The grammar stays shared; each caller can explain the narrower operation it actually supports. */
export function createActionSubjectRefSchema(description: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(ACTION_SUBJECT_REF_MAX_LENGTH)
    .regex(ACTION_SUBJECT_REF_PATTERN, description)
    .describe(description);
}

export const actionSubjectRefSchema = createActionSubjectRefSchema(ACTION_SUBJECT_REF_DESCRIPTION);
