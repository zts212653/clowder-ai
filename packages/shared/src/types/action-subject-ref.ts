import { z } from 'zod';

export const ACTION_SUBJECT_REF_DESCRIPTION =
  'subjectRef must use pr:<owner>/<repo>#<positive-number> (for example pr:zts212653/cat-cafe#2943) ' +
  'or subject:<namespace>:<opaque-id>. GitHub URL forms and SHA suffixes such as github:owner/repo#2943@abc123 are invalid.';

export const ACTION_SUBJECT_REF_MAX_LENGTH = 240;
// biome-ignore lint/suspicious/noControlCharactersInRegex: U+001F is the identity-key delimiter and must be excluded explicitly.
export const ACTION_SUBJECT_REF_PATTERN =
  /^(?:pr:[^/\s\x1f]+\/[^#\s\x1f]+#[1-9]\d*|subject:[a-z][a-z0-9_-]{0,63}:[^\s\x1f]{1,200})$/i;

export const actionSubjectRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(ACTION_SUBJECT_REF_MAX_LENGTH)
  .regex(ACTION_SUBJECT_REF_PATTERN, ACTION_SUBJECT_REF_DESCRIPTION)
  .describe(ACTION_SUBJECT_REF_DESCRIPTION);
