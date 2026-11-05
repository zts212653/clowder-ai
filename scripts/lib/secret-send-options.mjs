export const CURL_FILE_VALUES = new Set(['--upload-file', '-T', '--cookie-jar', '--cert', '--key', '--cacert']);
export const CURL_REFERENCES = new Set([
  '--data',
  '-d',
  '--data-ascii',
  '--data-binary',
  '--header',
  '-H',
  '--proxy-header',
  '--json',
  '--write-out',
  '-w',
]);
export const CURL_FORMS = new Set(['--form', '-F']);
export const CURL_VALUES = new Set([
  ...CURL_FILE_VALUES,
  ...CURL_REFERENCES,
  ...CURL_FORMS,
  '--url',
  '--request',
  '-X',
  '--output',
  '-o',
  '--user',
  '-u',
  '--proxy-user',
  '-U',
  '--proxy',
  '-x',
  '--max-time',
  '-m',
  '--connect-timeout',
  '--retry',
  '--retry-delay',
  '--user-agent',
  '-A',
  '--referer',
  '-e',
  '--cookie',
  '-b',
  '--data-urlencode',
  '--url-query',
  '--data-raw',
  '--form-string',
  '--resolve',
  '--connect-to',
  '--cacert',
  '--capath',
  '--write-out',
  '-w',
  '--dump-header',
  '-D',
  '--range',
  '-r',
  '--limit-rate',
  '--speed-limit',
  '-Y',
  '--speed-time',
  '-y',
  '--retry-max-time',
  '--proto',
  '--proto-redir',
  '--max-redirs',
  '--request-target',
  '--output-dir',
  '--interface',
  '--unix-socket',
  '--noproxy',
  '--expect100-timeout',
  '--tls-max',
]);

export const CURL_FLAGS = new Set([
  '-q',
  '--disable',
  '-f',
  '--fail',
  '--fail-with-body',
  '-s',
  '--silent',
  '-S',
  '--show-error',
  '-L',
  '--location',
  '-I',
  '--head',
  '-i',
  '--include',
  '-k',
  '--insecure',
  '-v',
  '--verbose',
  '-N',
  '--no-buffer',
  '-G',
  '--get',
  '-g',
  '--globoff',
  '-O',
  '--remote-name',
  '-J',
  '--remote-header-name',
  '-4',
  '--ipv4',
  '-6',
  '--ipv6',
  '-0',
  '--http1.0',
  '--http1.1',
  '--http2',
  '--http3',
  '--compressed',
  '--no-progress-meter',
  '--progress-bar',
  '-#',
  '--retry-all-errors',
  '--retry-connrefused',
  '--path-as-is',
  '--no-keepalive',
  '--no-sessionid',
  '--ssl-reqd',
  '--next',
  '--help',
  '-h',
  '--version',
  '-V',
]);

/** Keep a single option/value/operand classification for both managed senders. */
export function sendArguments(args, values, flags) {
  const words = flags ? expandShortOptions(args, values, flags) : args.map((word, index) => ({ word, index }));
  const output = [];
  let terminated = false;
  for (let cursor = 0; cursor < words.length; cursor++) {
    const { word, index } = words[cursor];
    if (terminated || !word.startsWith('-') || word === '-') {
      output.push({ kind: 'operand', word, index });
      continue;
    }
    if (word === '--') {
      terminated = true;
      output.push({ kind: 'terminator', word });
      continue;
    }
    const option = splitOption(word, values);
    if (!values.has(option.name)) {
      output.push({ kind: 'flag', word, name: option.name });
      continue;
    }
    const value = option.inline ? option.value : words[++cursor]?.word;
    if (value === undefined) throw new Error('secret_send_argument_missing');
    output.push({ kind: 'value', word, name: option.name, value });
  }
  return output;
}

/** Expand option tokens only; a value or a post-terminator operand is literal. */
function expandShortOptions(args, values, flags) {
  const output = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') return [...output, ...args.slice(index).map((word, offset) => ({ word, index: index + offset }))];
    const expanded = expandShortOption(arg, values, flags);
    output.push(...expanded.map((word) => ({ word, index })));
    const option = splitOption(expanded.at(-1), values);
    if (values.has(option.name) && !option.inline && index + 1 < args.length)
      output.push({ word: args[++index], index });
  }
  return output;
}

export function expandShortOption(arg, values, flags) {
  if (!/^-[^-].+/.test(arg) || values.has(arg.slice(0, 2))) return [arg];
  const output = [];
  for (let index = 1; index < arg.length; index++) {
    const flag = `-${arg[index]}`;
    const attached = arg.slice(index + 1);
    if (values.has(flag)) return [...output, `${flag}${attached}`];
    if (!flags.has(flag)) throw new Error('secret_send_option_unsupported');
    if (attached.startsWith('=')) {
      output.push(`${flag}${attached}`);
      return output;
    }
    output.push(flag);
  }
  return output;
}

export function splitOption(arg, valueOptions) {
  const equal =
    arg.startsWith('--') || (/^-[^-]=/.test(arg) && !valueOptions.has(arg.slice(0, 2))) ? arg.indexOf('=') : -1;
  if (equal >= 0) return { name: arg.slice(0, equal), value: arg.slice(equal + 1), inline: true };
  if (/^-[^-].+/.test(arg) && valueOptions.has(arg.slice(0, 2))) {
    return { name: arg.slice(0, 2), value: arg.slice(2), inline: true };
  }
  return { name: arg, inline: false };
}
