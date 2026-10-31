import { commandName, shellInvocation } from './native-effect-shell-tokenizer.mjs';

function curlWords(raw) {
  const parsed = shellInvocation(raw);
  return parsed.complete && parsed.redirections.length === 0 ? parsed.words.map(({ value }) => value) : null;
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
  return parsed && ['GET', 'HEAD'].includes(method) && parsed.urls.length && parsed.urls.every(isLoopbackHttpUrl)
    ? 'unknown'
    : 'service_mutation';
}

/** Option values have data roles, and -G changes data into URL query parameters. */
function parseCurlArguments(tokens) {
  const result = { urls: [], data: false, get: false, head: false };
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
