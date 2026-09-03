import { matchesGlob } from 'node:path';

const RUNTIME_COMPONENT = /(^|[/\s'"=])cat-cafe-runtime(?:\/|[\s'";&|()<>{}\n]|$)/i;
const RUNTIME_BRANCH = /(^|[\s'"=:/])runtime\/main-sync(?:[\s'";&|()<>{}]|$)/i;
const REDIS_6399 =
  /(?:\b(?:redis-cli|redis-server|lsof|localhost|127\.0\.0\.1)\b[^\n;&|]*\b6399\b|\b6399\b[^\n;&|]*\b(?:redis|lsof|kill)\b)/i;

export function classifyNativeTarget(raw, cwd, effect, ordinaryValueFallback) {
  const combined = `${cwd ?? ''}\n${raw}`;
  if (isBroadRootTarget(raw, cwd, effect)) return { kind: 'broad_root', value: broadRootValue(raw, cwd) };
  if (RUNTIME_COMPONENT.test(combined) || containsRuntimeComponentGlob(combined)) {
    return { kind: 'runtime_sanctuary', value: firstProtectedValue(raw, cwd) };
  }
  if (REDIS_6399.test(combined)) return { kind: 'redis_sanctuary', value: 'redis://127.0.0.1:6399' };
  if (namesRuntimeBranch(combined) || isProtectedBranchRewrite(raw)) {
    return {
      kind: 'protected_branch',
      value: namesRuntimeBranch(combined) ? 'runtime/main-sync' : protectedBranch(raw),
    };
  }
  return { kind: 'ordinary', value: firstOrdinaryValue(raw, cwd, ordinaryValueFallback) };
}

export function namesRuntimeBranch(raw) {
  return RUNTIME_BRANCH.test(raw) || containsRuntimeBranchGlob(raw);
}

function isBroadRootTarget(raw, cwd, effect) {
  if (!['delete', 'repository_rewrite', 'process_control', 'service_mutation', 'unknown'].includes(effect)) {
    return false;
  }
  if (shellTargetTokens(raw).some(isBroadRootSelector)) return true;

  const broadCwd = typeof cwd === 'string' && isBroadRootSelector(cwd);
  return broadCwd && /\b(?:find|rm|trash|unlink|rmdir|mv)\b[^;&|]*(?:^|\s)(?:\.|\.\/|\*)(?=$|[\s;&|])/i.test(raw);
}

function shellTargetTokens(raw) {
  return raw.match(/"[^"]*"|'[^']*'|[^\s;&|]+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
}

/** Normalize only selectors that still denote a protected root; ordinary descendants remain ordinary. */
function isBroadRootSelector(rawToken) {
  const token = rawToken.trim();
  if (!token) return false;
  if (token.startsWith('/') && /^[./*]*$/.test(token.slice(1))) return true;
  for (const home of ['~', '$HOME', '$' + '{HOME}']) {
    if (token === home || (token.startsWith(`${home}/`) && /^[./*]*$/.test(token.slice(home.length + 1)))) {
      return true;
    }
  }
  return /\/projects\/relay-station(?:\/cat-cafe)?[./*]*$/i.test(token);
}

function containsRuntimeComponentGlob(raw) {
  return shellTargetTokens(raw).some((token) =>
    token.split('/').some((segment) => globCanSelectLiteral(segment, 'cat-cafe-runtime')),
  );
}

function containsRuntimeBranchGlob(raw) {
  return shellTargetTokens(raw).some((token) => {
    const branchStart = token.indexOf('runtime/');
    return branchStart >= 0 && globCanSelectLiteral(token.slice(branchStart), 'runtime/main-sync');
  });
}

/** A shell glob that can select the protected literal is a protected target, not an ordinary sibling name. */
function globCanSelectLiteral(pattern, literal) {
  if (!/[*?[{]/.test(pattern)) return false;
  return matchesGlob(literal.toLowerCase(), pattern.toLowerCase());
}

function isProtectedBranchRewrite(raw) {
  const protectedName = '(?:main|master)';
  const gitCommand = String.raw`\bgit\b[^\n;&|]*`;
  return (
    new RegExp(String.raw`${gitCommand}\bfetch\b[^\n;&|]*\b${protectedName}\b`, 'i').test(raw) ||
    new RegExp(String.raw`${gitCommand}\bpush\b[^\n;&|]*(?:--force|-f\b)[^\n;&|]*\b${protectedName}\b`, 'i').test(
      raw,
    ) ||
    new RegExp(
      String.raw`${gitCommand}\bpush\b[^\n;&|]*(?:(?:--delete\b|-d\b)[^\n;&|]*\b${protectedName}\b|(?:^|\s):(?:refs\/heads\/)?${protectedName}\b|(?:^|\s)\+(?:[^\s:]+:)?(?:refs\/heads\/)?${protectedName}(?=$|[\s;&|]))`,
      'i',
    ).test(raw) ||
    new RegExp(String.raw`${gitCommand}\bupdate-ref\b[^\n;&|]*-d\b[^\n;&|]*refs\/heads\/${protectedName}\b`, 'i').test(
      raw,
    ) ||
    new RegExp(
      String.raw`${gitCommand}\bbranch\b[^\n;&|]*(?:-[dDmM]\b|--delete\b|--move\b)[^\n;&|]*\b${protectedName}\b`,
      'i',
    ).test(raw)
  );
}

function firstProtectedValue(raw, cwd) {
  const match = `${cwd ?? ''}\n${raw}`.match(/(?:\/[^\s'";&|]*)?cat-cafe-runtime(?:\/[^\s'";&|]*)?/i);
  return match?.[0] ?? 'cat-cafe-runtime';
}

function broadRootValue(raw, cwd) {
  return shellTargetTokens(raw).find(isBroadRootSelector) ?? cwd ?? '/';
}

function protectedBranch(raw) {
  return raw.match(/\b(main|master)\b/i)?.[1] ?? 'protected';
}

function firstOrdinaryValue(raw, cwd, fallback) {
  const patchPath = raw.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/m)?.[1]?.trim();
  const absolute = raw.match(/(?:^|[\s'"=])(\/[^\s'";&|]+)/)?.[1];
  return patchPath ?? absolute ?? fallback ?? cwd ?? '<unresolved>';
}
