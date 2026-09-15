import { DELETE_PROGRAMS, findArgvDeletes } from './native-effect-find-classifier.mjs';
import { isConstrainedLocalMediaObservation } from './native-effect-media-classifier.mjs';
import {
  constrainedGhPullRequestOperation,
  gitArgvRewritesRepository,
  isConstrainedGhPullRequestRead,
  isGitRepositoryObservation,
  isGitWriteOperation,
  isRepositoryRefresh,
  isRepositoryRewrite,
} from './native-effect-repository-classifier.mjs';
import {
  commandName,
  stripHarmlessRedirections,
  tokenizeSimpleShellCommand,
} from './native-effect-shell-tokenizer.mjs';

export {
  constrainedGhPullRequestOperation,
  explicitTemporaryWorktreeTarget,
} from './native-effect-repository-classifier.mjs';

export const SHELL_EFFECT_PRIORITY = new Map([
  ['read', 0],
  ['repository_refresh', 1],
  ['unknown', 2],
  ['write', 3],
  ['process_control', 4],
  ['delete', 5],
  ['repository_rewrite', 6],
  ['remote_mutation', 7],
  ['service_mutation', 8],
]);

export function classifyShellSegment(raw) {
  const command = stripHarmlessRedirections(raw);
  if (isRedisMutation(command)) return 'service_mutation';
  if (isUnsafeDateOperation(command) || isUnconstrainedHttpOperation(command)) return 'service_mutation';
  if (/\b(kill|pkill|killall)\b/i.test(command)) return 'process_control';
  if (isRepositoryRefresh(command)) return 'repository_refresh';
  if (constrainedGhPullRequestOperation(command)?.effect === 'remote_mutation') return 'remote_mutation';
  if (isRepositoryRewrite(command)) return 'repository_rewrite';
  if (isDeleteOperation(command)) return 'delete';
  if (isUnconstrainedSqliteOperation(command)) return 'write';
  if (isWriteOperation(command)) return 'write';
  if (isReadOperation(command)) return 'read';
  return 'unknown';
}

/**
 * Is this *resolved invocation* destructive, and how?
 *
 * A deliberately narrow contract: the two effects a caller needs when it is
 * about to decide whether something would destroy its own installation. It
 * takes argv and never rebuilds a string from it, because rebuilding is what
 * lets one operand be read as another command -- and it anchors on the program
 * and, for Git, on the subcommand that program would actually run.
 *
 * `classifyShellSegment` stays the answer for text, where a prefix this module
 * does not model may precede the program. This is the answer for an argv that
 * has already been resolved.
 *
 * @returns {'delete' | 'repository_rewrite' | undefined}
 */
export function destructiveInvocationEffect({ name, operands = [] } = {}) {
  const program = commandName(name ?? '') ?? '';
  if (program === 'git') return gitArgvRewritesRepository(operands) ? 'repository_rewrite' : undefined;
  if (DELETE_PROGRAMS.has(program)) return 'delete';
  if (program === 'find') return findArgvDeletes(operands) ? 'delete' : undefined;
  return undefined;
}

/** Split real pipelines and command lines without mistaking quoted or escaped separators for execution. */
export function splitShellExecutionSegments(raw) {
  return splitShellSegments(raw, true);
}

export function splitPipelineSegments(raw) {
  return splitShellSegments(raw, false);
}

export function isDataDrivenPipelineConsumer(raw) {
  return (
    /^\s*(?:xargs|sh|bash|zsh|eval)\b/i.test(raw) || /^\s*(?:node|python\d*|ruby|perl)\b[^\n]*\s-(?:\s|$)/i.test(raw)
  );
}

function splitShellSegments(raw, includeLineBoundaries) {
  const segments = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const scanned = scanShellCharacter(raw, index, quote, escaped, includeLineBoundaries);
    quote = scanned.quote;
    escaped = scanned.escaped;
    if (scanned.boundaryLength === 0) continue;
    if (scanned.boundaryKind === 'line' && !includeLineBoundaries) continue;
    segments.push(raw.slice(start, index));
    start = index + scanned.boundaryLength;
    index += scanned.boundaryLength - 1;
  }
  segments.push(raw.slice(start));
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function scanShellCharacter(raw, index, quote, escaped, includeExecutionBoundaries) {
  const char = raw[index];
  if (escaped) return { quote, escaped: false, boundaryLength: 0 };
  if (char === '\\' && quote !== "'") return { quote, escaped: true, boundaryLength: 0 };
  if (quote) return { quote: char === quote ? null : quote, escaped: false, boundaryLength: 0 };
  if (char === "'" || char === '"') return { quote: char, escaped: false, boundaryLength: 0 };
  const boundary = shellBoundaryAt(raw, index, includeExecutionBoundaries);
  return {
    quote: null,
    escaped: false,
    boundaryKind: boundary.kind,
    boundaryLength: boundary.length,
  };
}

function shellBoundaryAt(raw, index, includeExecutionBoundaries) {
  const char = raw[index];
  if (includeExecutionBoundaries && char === ';') return { kind: 'execution', length: 1 };
  if (includeExecutionBoundaries && char === '&' && raw[index + 1] === '&') {
    return { kind: 'execution', length: 2 };
  }
  if (includeExecutionBoundaries && char === '&' && raw[index - 1] !== '>') {
    return { kind: 'execution', length: 1 };
  }
  if (includeExecutionBoundaries && char === '|' && raw[index + 1] === '|') {
    return { kind: 'execution', length: 2 };
  }
  if (char === '|' && raw[index - 1] !== '|' && raw[index + 1] !== '|') {
    return { kind: 'pipeline', length: raw[index + 1] === '&' ? 2 : 1 };
  }
  if (char === '\n' || char === '\r') return { kind: 'line', length: crlfLength(raw, index) };
  return { kind: null, length: 0 };
}

function crlfLength(raw, index) {
  return raw[index] === '\r' && raw[index + 1] === '\n' ? 2 : 1;
}

function isDeleteOperation(raw) {
  if (/(?:^|[;&|]\s*)\s*(?:sudo\s+)?(?:rm|trash|unlink|rmdir)\b/i.test(raw)) return true;
  if (!/(?:^|[;&|]\s*)\s*find\b/i.test(raw)) return false;
  if (/\s-delete(?:\s|$)/i.test(raw)) return true;
  return /\s-(?:exec|execdir|ok|okdir)\b[^;&|\n]*(?:^|\s)(?:sudo\s+)?(?:rm|trash|unlink|rmdir)\b/i.test(raw);
}

function isRedisMutation(raw) {
  return /\bredis-cli\b[^\n;&|]*\b(shutdown|flushall|flushdb|set|del|unlink|rename|restore|migrate|save|bgsave)\b/i.test(
    raw,
  );
}

function isWriteOperation(raw) {
  return (
    /(?:^|[;&|]\s*)\s*(?:touch|mkdir|cp|mv|tee|install)\b/i.test(raw) ||
    /(?:^|[^<])>{1,2}(?!=)/.test(raw) ||
    isGitWriteOperation(raw)
  );
}

function isReadOperation(raw) {
  return (
    isConstrainedDateRead(raw) ||
    isStatRead(raw) ||
    isConstrainedLocalMediaObservation(raw) ||
    isGitRepositoryObservation(raw) ||
    isConstrainedGhPullRequestRead(raw) ||
    isConstrainedSqliteRead(raw) ||
    isConstrainedHttpRead(raw) ||
    isLocalObservation(raw) ||
    /^\s*cd\b[^;&|]*$/i.test(raw) ||
    /^\s*redis-cli\b[^\n;&|]*\b(?:ping|info|get|scan|keys|exists|ttl|pttl|type|dbsize|role)\b/i.test(raw) ||
    /^\s*cd\b[^;&|]*&&\s*git\s+(?:status|log|diff|show|branch(?:\s+--show-current)?)\b/i.test(raw) ||
    /^\s*(?:cat|ls|pwd|rg|grep|find|head|tail|sed\b(?![^\n]*\s-i\b)|echo|printf|git\s+(?:status|log|diff|show|branch))\b/i.test(
      raw,
    ) ||
    /^\s*(?:wc|uniq|cut|tr|column|jq)\b/i.test(raw) ||
    /^\s*sort\b(?![^\n]*(?:\s-o\b|\s--output(?:=|\s)))/i.test(raw)
  );
}

function isLocalObservation(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  if (!tokens) return false;
  const executable = tokens[0];
  if (['ps', '/bin/ps', '/usr/bin/ps', 'lsof', '/usr/bin/lsof', '/usr/sbin/lsof'].includes(executable)) return true;
  if (['test', '/bin/test', '/usr/bin/test'].includes(executable)) return tokens.length > 1;
  return ['[', '/bin/[', '/usr/bin/['].includes(executable) && tokens.at(-1) === ']';
}

function isConstrainedDateRead(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  if (!tokens || commandName(tokens[0]) !== 'date') return false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token.startsWith('+') ||
      ['-u', '--utc', '-R', '--rfc-email', '-j'].includes(token) ||
      /^-I(?:date|hours|minutes|seconds|ns)?$/.test(token) ||
      /^--iso-8601(?:=(?:date|hours|minutes|seconds|ns))?$/.test(token) ||
      /^--date=/.test(token) ||
      /^--reference=/.test(token)
    ) {
      continue;
    }
    if (['-d', '-r', '-f'].includes(token) && index + 1 < tokens.length) {
      index += 1;
      continue;
    }
    return false;
  }
  return true;
}

function isUnsafeDateOperation(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  return Boolean(tokens && commandName(tokens[0]) === 'date' && !isConstrainedDateRead(raw));
}

function isStatRead(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  return Boolean(tokens && commandName(tokens[0]) === 'stat');
}

function isConstrainedSqliteRead(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  if (!tokens || commandName(tokens[0]) !== 'sqlite3') return false;
  let index = 1;
  let readonly = false;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index];
    if (option === '-readonly') readonly = true;
    else if (!['-batch', '-noheader', '-header', '-json', '-csv', '-list', '-line'].includes(option)) return false;
    index += 1;
  }
  if (!readonly || index + 2 !== tokens.length) return false;
  const database = tokens[index];
  const query = tokens[index + 1].trim();
  if (!database || database.startsWith('-') || query.includes(';')) return false;
  if (!/^(?:select\b|with\b|explain\s+query\s+plan\s+select\b)/i.test(query)) return false;
  return !/\b(?:insert|update|delete|replace|create|drop|alter|attach|detach|vacuum|reindex|analyze|pragma|writefile|load_extension|eval)\b/i.test(
    query,
  );
}

function isUnconstrainedSqliteOperation(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  return Boolean(tokens && commandName(tokens[0]) === 'sqlite3' && !isConstrainedSqliteRead(raw));
}

function isConstrainedHttpRead(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  if (!tokens || commandName(tokens[0]) !== 'curl') return false;
  const parsed = parseCurlArguments(tokens);
  return Boolean(parsed && parsed.urls.length > 0 && parsed.urls.every(isLoopbackHttpUrl));
}

function parseCurlArguments(tokens) {
  const parsed = { method: 'GET', urls: [] };
  for (let index = 1; index < tokens.length; index += 1) {
    const option = parseCurlOption(tokens, index);
    if (!option) {
      parsed.urls.push(tokens[index]);
      continue;
    }
    if (!option.valid) return null;
    if (option.method) parsed.method = option.method;
    if (option.url) parsed.urls.push(option.url);
    index += option.consumed;
  }
  return ['GET', 'HEAD'].includes(parsed.method) ? parsed : null;
}

function parseCurlOption(tokens, index) {
  const token = tokens[index];
  if (!token.startsWith('-')) return null;
  if (/^-[fsSiI]+$/.test(token)) {
    return { valid: true, consumed: 0, ...(token.includes('I') ? { method: 'HEAD' } : {}) };
  }
  if (['--fail', '--silent', '--show-error', '--include', '--compressed'].includes(token)) {
    return { valid: true, consumed: 0 };
  }
  if (token === '--head') return { valid: true, consumed: 0, method: 'HEAD' };
  if (['-m', '--max-time', '--connect-timeout', '--retry', '--retry-delay', '-b', '--cookie'].includes(token)) {
    return tokens[index + 1] === undefined ? { valid: false, consumed: 0 } : { valid: true, consumed: 1 };
  }
  if (token === '-X' || token === '--request') return parseCurlMethodValue(tokens[index + 1]);
  if (/^-X/i.test(token)) return parseCurlMethodValue(token.slice(2), 0);
  if (token === '--url') {
    return tokens[index + 1] === undefined
      ? { valid: false, consumed: 0 }
      : { valid: true, consumed: 1, url: tokens[index + 1] };
  }
  return { valid: false, consumed: 0 };
}

function parseCurlMethodValue(raw, consumed = 1) {
  const method = raw?.toUpperCase();
  return ['GET', 'HEAD'].includes(method) ? { valid: true, consumed, method } : { valid: false, consumed: 0 };
}

function isUnconstrainedHttpOperation(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  return Boolean(tokens && commandName(tokens[0]) === 'curl' && !isConstrainedHttpRead(raw));
}

function isLoopbackHttpUrl(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}
