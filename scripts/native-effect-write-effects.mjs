import { sedScriptAnalysis } from './native-effect-sed-classifier.mjs';
import { commandName, shellInvocation } from './native-effect-shell-tokenizer.mjs';

// These are effects of the invoked program, never words found in its data.
// Unknown Redis commands retain the existing unknown-target policy.
const REDIS_MUTATIONS = new Set([
  'SHUTDOWN',
  'FLUSHALL',
  'FLUSHDB',
  'SET',
  'DEL',
  'UNLINK',
  'RENAME',
  'RESTORE',
  'MIGRATE',
  'SAVE',
  'BGSAVE',
  'HSET',
  'HSETNX',
  'HMSET',
  'HDEL',
  'EVAL',
  'EVALSHA',
  'FCALL',
]);
const REDIS_VALUES = new Set([
  '-h',
  '-p',
  '-u',
  '-a',
  '--user',
  '--pass',
  '-n',
  '-r',
  '-i',
  '--sni',
  '--cacert',
  '--cert',
  '--key',
]);
const REDIS_FLAGS = new Set([
  '--raw',
  '--no-raw',
  '--csv',
  '--json',
  '--quoted-json',
  '--tls',
  '--insecure',
  '--no-auth-warning',
  '-c',
  '-e',
  '-2',
  '-3',
]);

const REDIS_READS = new Set(['PING', 'INFO', 'GET', 'SCAN', 'KEYS', 'EXISTS', 'TTL', 'PTTL', 'TYPE', 'DBSIZE', 'ROLE']);

export function redisEffect(raw) {
  const command = redisCommand(raw);
  if (REDIS_MUTATIONS.has(command)) return 'service_mutation';
  return REDIS_READS.has(command) ? 'read' : 'unknown';
}

function redisCommand(raw) {
  const invocation = shellInvocation(raw);
  if (!invocation.complete) return null;
  const args = invocation.words.map(({ value }) => value);
  if (commandName(args[0]) !== 'redis-cli') return null;
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--eval' || token === '--pipe') return 'EVAL';
    if (REDIS_FLAGS.has(token)) continue;
    if (REDIS_VALUES.has(token)) {
      if (args[++index] === undefined) return null;
      continue;
    }
    return token.startsWith('-') ? null : token.toUpperCase();
  }
  return null;
}

export function fileProgramEffect(raw) {
  return fileProgramAnalysis(raw).effect;
}

/** The effect and its complete explicit file roles come from the same parse. */
export function fileProgramAnalysis(raw) {
  const invocation = shellInvocation(raw);
  if (!invocation.syntaxComplete || !invocation.words[0]?.literal) return { effect: 'unknown', paths: null };
  const name = commandName(invocation.words[0].value);
  if (!['sed', 'gsed', 'sort'].includes(name)) return { effect: 'unknown', paths: null };
  const analysis = fileArgumentAnalysis(invocation.words.slice(1), name === 'sort');
  if (name === 'gsed' && analysis.effect === 'read') return { effect: 'unknown', paths: null };
  // These roles describe the parsed invocation, not the executable selected by
  // an actual shell. They must not be used as a process/namespace certificate.
  return { ...analysis, redirections: invocation.redirections };
}

// These are option arities of the already-classified programs, not new safe commands.
const SORT_VALUE_OPTIONS = new Set([
  '--key',
  '--field-separator',
  '--buffer-size',
  '--batch-size',
  '--files0-from',
  '--parallel',
  '--random-source',
]);

function fileArgumentAnalysis(args, sort) {
  const state = { options: true, scripts: [], operands: [], paths: [], writes: [], effect: 'read', complete: true };
  for (let index = 0; index < args.length; index += 1) {
    const option = fileArgumentRole(args[index], state, sort);
    if (option.unresolved) state.complete = false;
    if (option.effect === 'write') state.effect = 'write';
    if (option.effect && !option.valueType) return incompleteEffect(state);
    if (option.valueType) {
      const argument = optionArgument(option, args[index + 1]);
      index += Number(option.attached === undefined);
      if (!consumeFileOptionValue(option.valueType, argument, state)) return incompleteEffect(state);
    }
  }
  return completedFileAnalysis(state, sort);
}

function optionArgument(option, followingWord) {
  return option.attached === undefined ? followingWord : { literal: true, value: option.attached };
}

function completedFileAnalysis(state, sort) {
  const script = sort ? { effect: 'read', paths: [], writes: [] } : fileSedAnalysis(state);
  const effect = state.effect === 'write' || script.effect === 'write' ? 'write' : script.effect;
  const rolesComplete = state.complete && script.paths !== null;
  if (!rolesComplete || state.operands.some((word) => !word.literal)) return { effect, paths: null, rolesComplete };
  return {
    effect,
    rolesComplete,
    paths: [
      ...state.paths,
      ...state.operands.filter((word) => word.value !== '-').map((word) => word.value),
      ...script.paths,
    ],
    writes: [...state.writes, ...script.writes],
  };
}

function fileSedAnalysis(state) {
  if (state.scripts.length === 0) {
    const script = state.operands.shift();
    if (!script?.literal) return { effect: 'unknown', paths: null };
    state.scripts.push(script.value);
  }
  return sedScriptAnalysis(state.scripts.join('\n'));
}

function incompleteEffect(state) {
  return { effect: state.effect === 'write' ? 'write' : 'unknown', paths: null };
}

function consumeFileOptionValue(type, argument, state) {
  if (!argument?.literal || ['script-file', 'file-list'].includes(type)) return false;
  if (type === 'script') state.scripts.push(argument.value);
  if (type === 'write-path' || type === 'read-path') state.paths.push(argument.value);
  if (type === 'write-path') state.writes.push(argument.value);
  return true;
}

function fileArgumentRole(word, state, sort) {
  if (!word.literal) {
    // Pure expansion with a fixed non-dash prefix cannot create an option.
    // After --, even a dash-leading expansion remains a file operand.
    const nonOption = word.literalPrefix.length > 0 && !word.literalPrefix.startsWith('-');
    if (state.options && !nonOption) return { effect: 'unknown' };
    state.operands.push(word);
    return {};
  }
  if (state.options && word.value === '--') {
    state.options = false;
    return {};
  }
  if (!state.options || !word.value.startsWith('-') || word.value === '-') {
    state.operands.push(word);
    return {};
  }
  return fileOption(word.value, sort);
}

function fileOption(token, sort) {
  if (token.startsWith('--')) return longFileOption(token, sort);
  const flags = sort ? 'bdfghimnrsuVzcCR' : 'nEruzsa';
  const values = sort
    ? { k: 'value', t: 'value', S: 'value', o: 'write-path', T: 'write-path' }
    : { e: 'script', f: 'script-file' };
  let unresolved = false;
  for (let index = 1; index < token.length; index += 1) {
    const flag = token[index];
    // An invalid short-option character stops getopt; later text in this same
    // quoted word cannot become another option (for example "-r -o").
    if (!/[A-Za-z]/.test(flag)) return { unresolved: true };
    if (!sort && flag === 'i') return { effect: 'write' };
    const valueType = values[flag];
    if (valueType) {
      return { ...valueOption(valueType, token, index + 1), unresolved };
    }
    if (!flags.includes(flag)) unresolved = true;
  }
  return { unresolved };
}

function valueOption(valueType, token, valueStart) {
  return {
    valueType,
    effect: valueType === 'write-path' ? 'write' : undefined,
    attached: valueStart === token.length ? undefined : token.slice(valueStart),
  };
}

function longFileOption(token, sort) {
  const [flag] = token.split('=', 1);
  // getopt_long accepts unique abbreviations; consuming their values is necessary
  // before interpreting a later -- as the option terminator.
  const output = sort ? '--output' : '--in-place';
  if (!sort && flag.length > 2 && output.startsWith(flag)) return { effect: 'write' };
  const writePath =
    sort && flag.length > 2 && [output, '--temporary-directory'].some((option) => option.startsWith(flag));
  if (sort && flag.length > 2 && '--compress-program'.startsWith(flag)) return { effect: 'unknown' };
  const values = sort ? [...SORT_VALUE_OPTIONS] : ['--expression', '--file'];
  const matches = values.filter((option) => option.startsWith(flag));
  if (!writePath && matches.length !== 1) return { unresolved: true };
  const valueType = writePath ? 'write-path' : longValueType(matches[0], sort);
  const equals = token.indexOf('=');
  return {
    valueType,
    effect: writePath ? 'write' : undefined,
    attached: equals < 0 ? undefined : token.slice(equals + 1),
  };
}

function longValueType(flag, sort) {
  if (!sort) return flag === '--expression' ? 'script' : 'script-file';
  if (flag === '--files0-from') return 'file-list';
  return flag === '--random-source' ? 'read-path' : 'value';
}
