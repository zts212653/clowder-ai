import { executedInvocations } from './lib/shell-invocation.mjs';
import { shellSegments } from './lib/shell-lexical.mjs';
import { SUBSTITUTION } from './lib/shell-text.mjs';
import { DELETE_PROGRAMS, findArgvDeletes, findExecutedCommands } from './native-effect-find-classifier.mjs';
import { constrainedGhApiOperation } from './native-effect-github-classifier.mjs';
import { classifyHttpOperation } from './native-effect-http-classifier.mjs';
import { FOREIGN_INTERPRETERS } from './native-effect-interpreter-source.mjs';
import { isConstrainedLocalMediaObservation } from './native-effect-media-classifier.mjs';
import {
  constrainedGhPullRequestOperation,
  gitArgvRewritesRepository,
  gitSubcommandArgs,
  isConstrainedGhPullRequestRead,
  isGitRepositoryObservation,
  isGitWriteOperation,
  isRepositoryRefresh,
} from './native-effect-repository-classifier.mjs';
import {
  commandName,
  shellInvocation,
  stripHarmlessRedirections,
  stripShellComments,
  tokenizeSimpleShellCommand,
  unquotedShellText,
} from './native-effect-shell-tokenizer.mjs';
import { isConstrainedSqliteRead, isUnconstrainedSqliteOperation } from './native-effect-sqlite-classifier.mjs';
import { fileProgramAnalysis, fileProgramEffect, redisEffect } from './native-effect-write-effects.mjs';

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
  const command = stripHarmlessRedirections(stripShellComments(raw));
  if (redisEffect(command) === 'service_mutation') return 'service_mutation';
  if (isUnsafeDateOperation(command)) return 'service_mutation';
  const httpEffect = classifyHttpOperation(command);
  if (httpEffect) return httpEffect;
  const execution = executedInvocations(command);
  const invocations = execution.pipelines.flat();
  const signals = invocations.filter(({ name }) => ['kill', 'pkill', 'killall'].includes(name));
  if (signals.some((invocation) => !isLivenessProbe(invocation))) return 'process_control';
  if (isRepositoryRefresh(command)) return 'repository_refresh';
  if ((constrainedGhApiOperation(command) ?? constrainedGhPullRequestOperation(command))?.effect === 'remote_mutation')
    return 'remote_mutation';
  if (invocations.some(({ name, operands }) => name === 'git' && gitArgvRewritesRepository(operands)))
    return 'repository_rewrite';
  if (invocations.some(({ name }) => DELETE_PROGRAMS.has(name))) return 'delete';
  if (isDeleteOperation(command)) return 'delete';
  if (isUnconstrainedSqliteOperation(command)) return 'write';
  if (invocations.some(({ name }) => ['touch', 'mkdir', 'cp', 'mv', 'tee', 'install'].includes(name))) return 'write';
  if (isWriteOperation(command)) return 'write';
  if (invocations.some(({ name, operands }) => name === 'find' && findExecutedCommands(operands).length))
    return 'unknown';
  if (execution.complete && isReadOperation(command)) return 'read';
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

const DATA_PROGRAMS = new Set(
  `base64 bat cat column curl cut diff echo envsubst fmt fold gh grep head jq less md5 md5sum more nl od
   paste pbcopy printf pv redis-cli rev rg sed shasum sort sqlite3 tac tail tee tr uniq wc wl-copy xclip xxd`
    .trim()
    .split(/\s+/),
);
const TMUX_CODE_COMMANDS = new Set([
  'new-session',
  'new-window',
  'split-window',
  'respawn-pane',
  'respawn-window',
  'run-shell',
]);
const GIT_PROTECTED_CONTROL_COMMANDS = new Set(['branch', 'fetch', 'push', 'update-ref']);

function unprovedExecutionCarrier(call) {
  if (call.name?.includes(' ')) return true;
  if (call.name === 'watch' || (call.name === 'su' && call.operands.includes('-c'))) return true;
  if (call.name === 'tmux') {
    if (call.operands[0] === 'send-keys')
      return call.operands.slice(1).some((word) => /^(?:Enter|C-[mj])$/i.test(word) || /[\r\n]/.test(word));
    return TMUX_CODE_COMMANDS.has(call.operands[0]);
  }
  if (call.name === 'gh' && call.operands[0] === 'alias' && call.operands[1] === 'set')
    return call.operands.some((word) => word.startsWith('!'));
  if (call.name === 'sed')
    return call.operands.some((word) =>
      /(?:^|[;{}\n/])\s*e(?:\s|$)|(?:^|[;{}\n])\s*s([^A-Za-z0-9\\\s]).*\1.*\1[A-Za-z]*e[A-Za-z]*(?:$|[;{}\n])/s.test(
        word,
      ),
    );
  if (['docker', 'kubectl'].includes(call.name) && call.operands.includes('exec')) return true;
  return call.name === 'awk' && call.operands.some((word) => /\bsystem\s*\(|\|&?\s*(?:["']|getline\b)/.test(word));
}

/** A data-classified call does not prove executable Git selectors or generated control argv. */
function unprovedGitEvidence(call) {
  if (call.name !== 'git') return [];
  const args = gitSubcommandArgs(call.operands);
  if (!args) return [];
  const options = call.operands.slice(0, call.operands.length - args.length);
  const evidence = options.some((word) => /^-c|^--(?:config-env|exec-path)(?:=|$)/.test(word))
    ? [options.join(' ')]
    : [];
  if (GIT_PROTECTED_CONTROL_COMMANDS.has(args[0]) && call.argumentEvidence?.length) evidence.push(call.text);
  return evidence;
}

function namedDataCall(call) {
  if (DATA_PROGRAMS.has(call.name))
    return (
      !unprovedExecutionCarrier(call) &&
      (call.name !== 'rg' || !call.operands.some((word) => /^(?:--pre|--hostname-bin)(?:=|$)/.test(word)))
    );
  if (call.name === 'awk') return !unprovedExecutionCarrier(call);
  if (call.name === 'tmux' && call.operands[0] === 'send-keys') return !unprovedExecutionCarrier(call);
  if (['pnpm', 'npm'].includes(call.name) && call.operands[0] === 'test') return true;
  if (FOREIGN_INTERPRETERS.test(call.interpreter ?? call.name ?? ''))
    return call.interpreter !== undefined || (call.operands.length > 0 && !call.operands.includes('-'));
  return false;
}

function provenGitData(call) {
  if (call.name !== 'git') return false;
  const args = gitSubcommandArgs(call.operands);
  if (!args) return false;
  if (['commit', 'tag', 'notes', 'stash', 'merge'].includes(args[0])) return true;
  if (['log', 'diff', 'show'].includes(args[0])) return true;
  const normalized = ['git', ...args].map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(' ');
  return (
    isGitRepositoryObservation(normalized, (word) => !word.includes(SUBSTITUTION)) || isRepositoryRefresh(normalized)
  );
}

function provenDataCall(call) {
  if (call.unprovedCodeEvidence?.length) return false;
  return call.delegated || namedDataCall(call) || provenGitData(call);
}

/** Evidence that may still be executed; classified data roles never become shell source. */
export function shellExecutionEvidence(call, fallbackCwd) {
  const effect = destructiveInvocationEffect(call);
  const texts =
    !effect && provenDataCall(call)
      ? unprovedGitEvidence(call)
      : [
          ...(effect ? [call.argvEvidence] : []),
          ...(call.codeEvidence ?? []),
          ...(call.unprovedCodeEvidence ?? []),
          ...(call.argumentEvidence ?? []),
          ...(call.inputEvidence ?? []),
          call.text,
          call.argvEvidence,
        ];
  return [...new Set(texts.filter(Boolean))].map((text) => ({
    text,
    cwd: call.cwd ?? fallbackCwd,
    effect: effect ?? 'unknown',
  }));
}

/** Split real pipelines and command lines without mistaking quoted or escaped separators for execution. */
export function splitShellExecutionSegments(raw) {
  return splitShellSegments(raw, true).map((segment) => segment.text);
}

/** The same split, keeping the separator in front of each segment (`&&`, `||`, `;`, `&`, `|`, newline). */
export function splitShellExecutionSegmentsWithSeparators(raw) {
  return splitShellSegments(raw, true);
}

export function splitPipelineSegments(raw) {
  return splitShellSegments(raw, false).map((segment) => segment.text);
}

export function isDataDrivenPipelineConsumer(raw) {
  return (
    /^\s*(?:xargs|sh|bash|zsh|eval)\b/i.test(raw) || /^\s*(?:node|python\d*|ruby|perl)\b[^\n]*\s-(?:\s|$)/i.test(raw)
  );
}

function splitShellSegments(raw, includeLineBoundaries) {
  return shellSegments(raw, { lines: includeLineBoundaries, execution: includeLineBoundaries }).segments;
}

function isDeleteOperation(raw) {
  if (/(?:^|[;&|]\s*)\s*(?:sudo\s+)?(?:rm|trash|unlink|rmdir)\b/i.test(raw)) return true;
  if (!/(?:^|[;&|]\s*)\s*find\b/i.test(raw)) return false;
  if (/\s-delete(?:\s|$)/i.test(raw)) return true;
  return /\s-(?:exec|execdir|ok|okdir)\b[^;&|\n]*(?:^|\s)(?:sudo\s+)?(?:rm|trash|unlink|rmdir)\b/i.test(raw);
}

function isWriteOperation(raw) {
  return (
    fileProgramEffect(raw) === 'write' ||
    /(?:^|[;&|]\s*)\s*(?:touch|mkdir|cp|mv|tee|install)\b/i.test(raw) ||
    // Quoted `>` is text (`stat -f '%N -> %Y'`, `rg 'a > b'`), not a redirection.
    /(?:^|[^<])>{1,2}(?!=)|<>/.test(unquotedShellText(raw)) ||
    isGitWriteOperation(raw)
  );
}

function isReadOperation(raw) {
  const files = fileProgramAnalysis(raw);
  if (files.handled && files.effect !== 'read') return false;
  return (
    isConstrainedDateRead(raw) ||
    isStatRead(raw) ||
    isConstrainedLocalMediaObservation(raw) ||
    isGitRepositoryObservation(raw) ||
    isConstrainedGhPullRequestRead(raw) ||
    constrainedGhApiOperation(raw)?.effect === 'read' ||
    isConstrainedSqliteRead(raw) ||
    isLocalObservation(raw) ||
    /^\s*cd\b[^;&|]*$/i.test(raw) ||
    redisEffect(raw) === 'read' ||
    /^\s*cd\b[^;&|]*&&\s*git\s+(?:status|log|diff|show|branch(?:\s+--show-current)?)\b/i.test(raw) ||
    /^\s*(?:cat|ls|pwd|rg|grep|find|head|tail|echo|printf|git\s+(?:status|log|diff|show|branch))\b/i.test(raw) ||
    /^\s*(?:wc|uniq|cut|tr|column|jq)\b/i.test(raw) ||
    (!files.handled && files.effect === 'read')
  );
}

function isLocalObservation(raw) {
  if (isDiffRead(raw)) return true;
  const tokens = tokenizeSimpleShellCommand(raw);
  if (!tokens) return false;
  const executable = tokens[0];
  if (['du', 'sleep'].includes(executable)) return true;
  if (executable === 'shasum') return !tokens.slice(1).some((token) => ['-c', '--check', '--status'].includes(token));
  if (isLivenessProbe({ name: executable, operands: tokens.slice(1) })) return true;
  if (['ps', '/bin/ps', '/usr/bin/ps', 'lsof', '/usr/bin/lsof', '/usr/sbin/lsof'].includes(executable)) return true;
  if (['test', '/bin/test', '/usr/bin/test'].includes(executable)) return tokens.length > 1;
  return ['[', '/bin/[', '/usr/bin/['].includes(executable) && tokens.at(-1) === ']';
}

function isDiffRead(raw) {
  const invocation = shellInvocation(raw);
  if (!invocation.complete || invocation.words.some((word) => !word.literal)) return false;
  const [program, ...args] = invocation.words.map((word) => word.value);
  if (program !== 'diff') return false;
  let operands = 0;
  let options = true;
  for (const token of args) {
    if (options && token === '--') options = false;
    else if (!options || !token.startsWith('-') || token === '-') operands++;
    else if (
      !/^-[abBcdiNpqrstTuwyZ]+$/.test(token) &&
      ![
        '--text',
        '--brief',
        '--recursive',
        '--unified',
        '--context',
        '--ignore-case',
        '--report-identical-files',
      ].includes(token)
    )
      return false;
  }
  return operands === 2;
}

function isLivenessProbe({ name, operands }) {
  return (
    name === 'kill' &&
    operands?.length >= 2 &&
    operands[0] === '-0' &&
    operands.slice(1).every((value) => /^\d+$/.test(value))
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
