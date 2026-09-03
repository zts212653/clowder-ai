import { namesRuntimeBranch } from './native-effect-target-classifier.mjs';

export const SHELL_EFFECT_PRIORITY = new Map([
  ['read', 0],
  ['repository_refresh', 1],
  ['unknown', 2],
  ['write', 3],
  ['process_control', 4],
  ['delete', 5],
  ['repository_rewrite', 6],
  ['service_mutation', 7],
]);

export function classifyShellSegment(raw) {
  const command = stripHarmlessRedirections(raw);
  if (isRedisMutation(command)) return 'service_mutation';
  if (isUnsafeDateOperation(command) || isUnconstrainedHttpOperation(command)) return 'service_mutation';
  if (/\b(kill|pkill|killall)\b/i.test(command)) return 'process_control';
  if (isRepositoryRefresh(command)) return 'repository_refresh';
  if (isRepositoryRewrite(command)) return 'repository_rewrite';
  if (isDeleteOperation(command)) return 'delete';
  if (isUnconstrainedSqliteOperation(command)) return 'write';
  if (isWriteOperation(command)) return 'write';
  if (isReadOperation(command)) return 'read';
  return 'unknown';
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

/** `/dev/null` and fd duplication are sinks, not mutations of the command's cwd. */
function stripHarmlessRedirections(raw) {
  return raw.replace(/(?:^|\s)(?:\d*>{1,2}\s*\/dev\/null|\d*>\s*&\s*\d+)(?=\s|$)/g, ' ');
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

function isRepositoryRewrite(raw) {
  return (
    (isGitFetchCommand(raw) && !isRepositoryRefresh(raw)) ||
    /\bgit\b[^\n;&|]*\b(reset\s+--hard|push\b[^\n;&|]*(?:--force|-f\b)|branch\b[^\n;&|]*(?:-[dDmM]\b|--delete|--move)|update-ref\b[^\n;&|]*-d\b|worktree\s+remove)\b/i.test(
      raw,
    ) ||
    /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(?:--delete\b|-d\b|(?:^|\s):[^\s;&|]+|(?:^|\s)\+[^\s;&|]+)/i.test(raw) ||
    (namesRuntimeBranch(raw) &&
      /\bgit\b[^\n;&|]*\b(checkout|switch|merge|rebase|push|pull|update-ref|branch)\b/i.test(raw))
  );
}

function isWriteOperation(raw) {
  return (
    /(?:^|[;&|]\s*)\s*(?:touch|mkdir|cp|mv|tee|install)\b/i.test(raw) ||
    /(?:^|[^<])>{1,2}(?!=)/.test(raw) ||
    /\bgit\b[^\n;&|]*\b(?:add|commit|merge|rebase|checkout|switch|push|pull|cherry-pick|stash)\b/i.test(raw)
  );
}

function isReadOperation(raw) {
  return (
    isConstrainedDateRead(raw) ||
    isStatRead(raw) ||
    isGitRepositoryObservation(raw) ||
    isConstrainedSqliteRead(raw) ||
    isConstrainedHttpRead(raw) ||
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

function isGitRepositoryObservation(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  const args = gitCommandArgs(tokens);
  if (!args) return false;
  if (['rev-parse', 'rev-list'].includes(args[0])) return true;
  return (
    args[0] === 'ls-remote' &&
    args.length >= 2 &&
    args.length <= 3 &&
    args[1] === 'origin' &&
    (args.length === 2 || ['main', 'refs/heads/main'].includes(args[2]))
  );
}

function isRepositoryRefresh(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  const args = gitCommandArgs(tokens);
  if (!args || args[0] !== 'fetch') return false;
  const fetchArgs = args.slice(1).filter((token) => !['--quiet', '-q', '--no-tags'].includes(token));
  return fetchArgs.length === 2 && fetchArgs[0] === 'origin' && fetchArgs[1] === 'main';
}

function isGitFetchCommand(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  return gitCommandArgs(tokens)?.[0] === 'fetch';
}

/** Peel off Git's repository selector without weakening classification of its subcommand. */
function gitCommandArgs(tokens) {
  if (!tokens || commandName(tokens[0]) !== 'git') return null;
  let index = 1;
  while (tokens[index] === '-C') {
    if (!tokens[index + 1]) return null;
    index += 2;
  }
  return tokens.slice(index);
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

function tokenizeSimpleShellCommand(raw) {
  if (/`|\$\(|[<>]\(/.test(raw)) return null;
  const tokenPattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|((?:\\.|[^\s"'\\])+)/g;
  const tokens = [];
  let cursor = 0;
  for (const match of raw.matchAll(tokenPattern)) {
    if (raw.slice(cursor, match.index).trim()) return null;
    tokens.push(decodeShellToken(match));
    cursor = (match.index ?? 0) + match[0].length;
  }
  return raw.slice(cursor).trim() ? null : tokens;
}

function decodeShellToken(match) {
  if (match[2] !== undefined) return match[2];
  return (match[1] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
}

function commandName(raw) {
  return raw?.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase();
}
