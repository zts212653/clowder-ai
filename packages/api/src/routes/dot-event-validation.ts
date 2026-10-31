import type { ZodError, ZodIssue } from 'zod';

const paths = new Set([
  '',
  'name',
  'arguments',
  'arguments.attempt_id',
  'arguments.pairing_code',
  'delivery',
  'delivery.mode',
  'delivery.url',
  'delivery.secret',
  'cursor',
  'ttlMs',
  'maxAgeMs',
  '_meta',
]);
const extensionKeys = new Set(['_meta', 'maxAgeMs', 'inputResponses', 'requestState']);

function projectIssue(issue: ZodIssue) {
  const candidate = issue.path.join('.');
  const path = paths.has(candidate) ? candidate : '<redacted>';
  const common = { path, code: issue.code };
  if (issue.code === 'invalid_type') return { ...common, expected: issue.expected };
  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys.filter((key) => extensionKeys.has(key)).sort();
    return { ...common, keys, unknownKeyCount: issue.keys.length - keys.length };
  }
  return common;
}

/** Never serialize Zod's raw issue/message, input values, or arbitrary client key names. */
export function dotEventValidationDiagnostics(error: ZodError) {
  return {
    dotPhase: 'subscription_parse',
    dotValidationIssueCount: error.issues.length,
    dotValidationIssues: error.issues.slice(0, 8).map(projectIssue),
  };
}
