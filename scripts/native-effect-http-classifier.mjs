import { isAbsolute } from 'node:path';
import { kernelPath, unfoldedJoin } from './lib/shell-directory.mjs';
import { physicalWriteTarget } from './native-effect-media-classifier.mjs';
import { commandName, shellInvocation } from './native-effect-shell-tokenizer.mjs';

function curlWords(raw) {
  const parsed = shellInvocation(raw);
  return parsed.complete ? parsed.words.map(({ value }) => value) : null;
}

const VALUES = new Set([
  '--max-time',
  '--connect-timeout',
  '--retry',
  '--retry-delay',
  '--cookie',
  '--header',
  '--user-agent',
  '--request',
  '--url',
  '--data',
  '--data-raw',
  '--data-urlencode',
  '--data-binary',
  '--output',
  '--dump-header',
  '--stderr',
  '--write-out',
  '--noproxy',
]);
const FLAGS = new Set([
  '--fail',
  '--silent',
  '--show-error',
  '--include',
  '--compressed',
  '--head',
  '--get',
  '--disable',
]);
const SHORT = new Map([
  ['m', '--max-time'],
  ['b', '--cookie'],
  ['H', '--header'],
  ['A', '--user-agent'],
  ['X', '--request'],
  ['d', '--data'],
  ['G', '--get'],
  ['I', '--head'],
  ['f', '--fail'],
  ['s', '--silent'],
  ['S', '--show-error'],
  ['i', '--include'],
  ['q', '--disable'],
  ['o', '--output'],
  ['D', '--dump-header'],
  ['w', '--write-out'],
]);

/** argv describes a candidate; startup configuration and final env belong to the executor. */
export function classifyHttpOperation(raw) {
  const tokens = curlWords(raw);
  if (commandName(shellInvocation(raw).words[0]?.value ?? '') !== 'curl') return null;
  if (!tokens) return 'service_mutation';
  const parsed = parseCurlArguments(tokens);
  const method =
    parsed?.method ??
    (parsed?.get ? (parsed.head ? 'HEAD' : 'GET') : parsed?.head ? 'HEAD' : parsed?.data ? 'POST' : 'GET');
  // Even first-argument -q only suppresses .curlrc. Proxy/env/executable facts are
  // absent from current native payloads, so no argv shape grants a readonly exemption.
  if (!parsed || !['GET', 'HEAD'].includes(method) || !parsed.urls.length || !parsed.urls.every(isLoopbackHttpUrl))
    return 'service_mutation';
  const redirected = shellInvocation(raw).redirections.some(
    (item) => item.operator.includes('>') && item.operand.value !== '/dev/null',
  );
  return parsed.outputs.some(fileOutput) || redirected ? 'write' : 'unknown';
}

/** GET remains an unknown network effect. Its explicitly named output files are
 * independent local writes; URL and working directory are not those files. */
export function httpOutputTargets(raw, cwd) {
  if (classifyHttpOperation(raw) !== 'write') return null;
  const parsed = parseCurlArguments(curlWords(raw));
  const redirects = shellInvocation(raw).redirections.filter((item) =>
    /^(?:\d*|&)(?:>|>>|>\||<>)$/.test(item.operator),
  );
  // '-' is curl's stdout sentinel only in curl option values. Shell > - writes
  // a real file named '-' in cwd, so retain that operand as a file target.
  const outputs = [
    ...parsed.outputs.filter(fileOutput),
    ...redirects.map((item) => item.operand.value).filter((path) => path !== '/dev/null'),
  ];
  const base = cwd ? kernelPath(cwd) : null;
  const paths = outputs.map((path) =>
    /[$`*?[\]{}]|(?:^|\/)\.\.(?:\/|$)/.test(path)
      ? null
      : isAbsolute(path)
        ? path
        : base
          ? unfoldedJoin(base, path)
          : null,
  );
  const physical = paths.map((path) => (path ? physicalWriteTarget(path) : null));
  return {
    complete: physical.length > 0 && physical.every(Boolean),
    targetText: [...paths, ...physical]
      .filter(Boolean)
      .map((path) => JSON.stringify(path))
      .join(' '),
  };
}

const fileOutput = (path) => !['-', '/dev/null'].includes(path);

/** Option values have data roles, and -G changes data into URL query parameters. */
function parseCurlArguments(tokens) {
  if (!tokens) return null;
  const result = { urls: [], data: false, get: false, head: false, outputs: [] };
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('-')) {
      result.urls.push(token);
      continue;
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const option = equals < 0 ? token : token.slice(0, equals);
      if (FLAGS.has(option) && equals < 0) {
        applyOption(result, option);
        continue;
      }
      if (!VALUES.has(option)) return null;
      const value = equals < 0 ? tokens[++index] : token.slice(equals + 1);
      if (value === undefined || !applyOption(result, option, value)) return null;
    } else {
      for (let offset = 1; offset < token.length; offset += 1) {
        const option = SHORT.get(token[offset]);
        if (!option) return null;
        if (VALUES.has(option)) {
          const value = offset + 1 < token.length ? token.slice(offset + 1) : tokens[++index];
          if (value === undefined || !applyOption(result, option, value)) return null;
          break;
        }
        applyOption(result, option);
      }
    }
  }
  return result;
}

function applyOption(result, option, value) {
  if (['--output', '--dump-header', '--stderr'].includes(option)) result.outputs.push(value);
  if (option === '--write-out' && /%output\{|^@/.test(value)) return false;
  if (option === '--request') result.method = value.toUpperCase();
  if (option === '--url') result.urls.push(value);
  if (option === '--get') result.get = true;
  if (option === '--head') result.head = true;
  if (option.startsWith('--data')) {
    // Files/config-driven requests need a separate access contract; do not infer contents.
    if (value.startsWith('@')) return false;
    result.data = true;
  }
  return true;
}

function isLoopbackHttpUrl(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}
