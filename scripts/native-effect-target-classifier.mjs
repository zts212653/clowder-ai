import { homedir } from 'node:os';
import { dirname, isAbsolute, matchesGlob, resolve } from 'node:path';
import { kernelPath, unfoldedJoin } from './lib/shell-directory.mjs';
import { shellWords } from './native-effect-shell-tokenizer.mjs';

const RUNTIME_COMPONENT = /(^|[/\s'"=])cat-cafe-runtime(?:\/|[\s'";&|()<>{}\n]|$)/i;
const RUNTIME_BRANCH = /(^|[\s'"=:/])runtime\/main-sync(?:[\s'";&|()<>{}]|$)/i;
const REDIS_6399 =
  /(?:\b(?:redis-cli|redis-server|lsof|localhost|127\.0\.0\.1)\b[^\n;&|]*\b6399\b|\b6399\b[^\n;&|]*\b(?:redis|lsof|kill)\b)/i;

export function classifyNativeTarget(raw, cwd, effect, ordinaryValueFallback) {
  const combined = `${cwd ?? ''}\n${raw}`;
  if (isBroadRootTarget(raw, cwd, effect)) return { kind: 'broad_root', value: broadRootValue(raw, cwd) };
  // A wildcard can select the runtime only for an effect we recognised. For a command we
  // could not read, `**/test/**` is a pathspec, not evidence of a runtime target.
  if (RUNTIME_COMPONENT.test(combined) || (effect !== 'unknown' && containsRuntimeComponentGlob(raw, cwd))) {
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

// Only a recognised destructive effect can make a root the target. An unrecognised command
// that merely mentions `/`, `~` or the main checkout (a `cd`, a document body) is not one:
// on 2026-09-26 that rule produced the largest share of every guard denial across threads.
function isBroadRootTarget(raw, cwd, effect) {
  if (!['delete', 'repository_rewrite', 'process_control', 'service_mutation'].includes(effect)) {
    return false;
  }
  if (shellTargetTokens(raw).some(isBroadRootSelector)) return true;

  const broadCwd = typeof cwd === 'string' && isBroadRootSelector(cwd);
  if (broadCwd && /\b(?:find|rm|trash|unlink|rmdir|mv)\b[^;&|]*(?:^|\s)(?:\.|\.\/|\*)(?=$|[\s;&|])/i.test(raw)) {
    return true;
  }
  // `git reset --hard` (without -C) rewrites the checkout it runs in; in the shared main
  // checkout that discards other cats' uncommitted work.
  return effect === 'repository_rewrite' && insideMainCheckout(cwd) && /^\s*git\s+reset\s+--hard\b/i.test(raw);
}

function insideMainCheckout(cwd) {
  return typeof cwd === 'string' && /\/projects\/relay-station\/cat-cafe(?:\/|$)/i.test(cwd);
}

function shellTargetTokens(raw) {
  return (
    shellWords(raw)?.map((word) => word.value) ??
    raw.match(/"[^"]*"|'[^']*'|[^\s;&|]+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, '$2')) ??
    []
  );
}

/** Normalize only selectors that still denote a protected root; ordinary descendants remain ordinary. */
function isBroadRootSelector(rawToken) {
  const token = rawToken.trim();
  if (!token) return false;
  if (token.startsWith('/') && /^[./*]*$/.test(token.slice(1))) return true;
  for (const home of ['~', '$HOME', '$' + '{HOME}', homedir()]) {
    if (token === home || (token.startsWith(`${home}/`) && /^[./*]*$/.test(token.slice(home.length + 1)))) {
      return true;
    }
  }
  return /\/projects\/relay-station(?:\/cat-cafe)?[./*]*$/i.test(token);
}

function containsRuntimeComponentGlob(raw, cwd) {
  const tokens = shellTargetTokens(raw);
  // Locate the installation independently of the wildcard. Its parent cwd is
  // already a coordinate, even with no checkout component. Conversely, an
  // operand /tmp/cat-cafe-* does not invent a second protected installation.
  const roots = [cwd, ...tokens.filter(isAbsolute)].flatMap((value) => {
    const coordinate = value === cwd ? (kernelPath(value ?? '') ?? value) : value;
    const parent =
      coordinate?.match(/^(.*\/projects\/relay-station)(?:\/|$)/)?.[1] ??
      (value === cwd ? coordinate?.match(/^(.*)\/cat-cafe[^/]*(?:\/|$)/)?.[1] : undefined);
    if (!parent || /[$*?[{]/.test(parent) || (!isAbsolute(parent) && !cwd)) return [];
    const joined = unfoldedJoin(cwd ?? '/', `${parent}/cat-cafe-runtime`);
    return [kernelPath(joined) ?? resolve(joined)];
  });
  return tokens.some((token) => {
    const wildcard = token.search(/[*?[{]/);
    if (wildcard < 0 || /[$`]/.test(token)) return false;
    const slash = token.lastIndexOf('/', wildcard);
    const parent = slash < 0 ? '.' : token.slice(0, slash + 1);
    if (!isAbsolute(parent) && !cwd) return false;
    const joined = unfoldedJoin(cwd ?? '/', parent);
    const physicalParent = kernelPath(joined) ?? resolve(joined);
    const pattern = `${physicalParent}/${token.slice(slash + 1)}`;
    return roots.some((root) => {
      for (let candidate = root; candidate !== '/'; candidate = dirname(candidate)) {
        if (matchesGlob(candidate, pattern)) return true;
      }
      return false;
    });
  });
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
