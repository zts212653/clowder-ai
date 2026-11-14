import { assertSecretFree } from './secret-payload-files.mjs';
import { CURL_FLAGS, CURL_VALUES, sendArguments } from './secret-send-options.mjs';

const AUTH_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key']);
const HEADER_OPTIONS = new Set(['-H', '--header', '--proxy-header']);
const HEADER_VALUES = new Set([
  '-X',
  '--request',
  '-A',
  '--user-agent',
  '-e',
  '--referer',
  '-b',
  '--cookie',
  '-r',
  '--range',
]);
const DESTINATION_OVERRIDES = new Set([
  '-L',
  '--location',
  '--next',
  '-k',
  '--insecure',
  '--resolve',
  '--connect-to',
  '--unix-socket',
  '--request-target',
  '-v',
  '--verbose',
]);

function canonicalDestination(urls) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject bytes that URL parsers normalize differently.
  if (urls.length !== 1 || /[\\\u0000-\u001f\u007f]/u.test(urls[0]))
    throw new Error('platform_auth_destination_ambiguous');
  return new URL(urls[0]).href;
}

/** Validate the same bytes later frozen for curl, including header-file and stdin carriers. */
export function assertPlatformSupplementalHeaders(content) {
  for (const line of Buffer.from(content).toString('utf8').split(/\r?\n/u)) {
    if (!line) continue;
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?::[^\r\n\0]*|;)$/u.exec(line);
    if (!match || /^(?:host|authorization|x-api-key|x-goog-api-key)$/i.test(match[1]))
      throw new Error('platform_auth_header_override');
  }
}

function assertInlineHeaders(parsed, auth) {
  for (const item of parsed) {
    if (item.kind !== 'value') continue;
    if ((HEADER_OPTIONS.has(item.name) || HEADER_VALUES.has(item.name)) && /[\r\n\0]/u.test(item.value))
      throw new Error('platform_auth_header_invalid');
    if (HEADER_OPTIONS.has(item.name) && item !== auth && !item.value.startsWith('@'))
      assertPlatformSupplementalHeaders(item.value);
  }
}

/** A narrowly scoped authentication exception; all other request bytes are still inspected. */
export async function platformCurlAuthentication(args) {
  const parsed = sendArguments(args, CURL_VALUES, CURL_FLAGS);
  const headers = parsed.filter((x) => x.kind === 'value' && (x.name === '-H' || x.name === '--header'));
  const auth = headers.filter((x) => AUTH_HEADERS.has(x.value.split(':', 1)[0].toLowerCase()));
  if (!auth.length) return { scanArgs: args, credentials: [] };
  if (auth.length !== 1) throw new Error('platform_auth_ambiguous');
  const urls = parsed.flatMap((x) =>
    x.kind === 'operand' ? [x.word] : x.kind === 'value' && x.name === '--url' ? [x.value] : [],
  );
  const match = /^([^:\s]+):\s*([^\r\n]+)$/.exec(auth[0].value);
  if (!match) throw new Error('platform_auth_header_invalid');
  const destination = canonicalDestination(urls);
  // This host module uses the same account snapshot/resolver as Hub and the transport.
  let verdict = 'unrecognized';
  try {
    const { authorizePlatformAuthentication } = await import(
      '../../packages/api/dist/config/platform-authentication.js'
    );
    verdict = authorizePlatformAuthentication({ destination, header: match[1], value: match[2] });
  } catch {
    /* Without the host's account owner there is no authentication exception. */
  }
  if (verdict === 'unrecognized') {
    assertSecretFree(auth[0].value);
    return { scanArgs: args, credentials: [] };
  }
  if (verdict !== 'allowed') throw new Error('platform_auth_destination_denied');
  if (parsed.some((x) => DESTINATION_OVERRIDES.has(x.name))) throw new Error('platform_auth_destination_ambiguous');
  assertInlineHeaders(parsed, auth[0]);
  return admittedArguments(parsed, auth[0], match, destination);
}

function admittedArguments(parsed, auth, match, destination) {
  const credential = match[1].toLowerCase() === 'authorization' ? match[2].slice(7) : match[2];
  const scanArgs = [];
  const sendArgs = [];
  for (const item of parsed) {
    if (item.kind === 'value') {
      const value = item.name === '--url' ? destination : item.value;
      sendArgs.push(item.name, value);
      scanArgs.push(item.name, item === auth ? `${match[1]}: [host authentication]` : value);
    } else {
      const word = item.kind === 'operand' ? destination : item.word;
      sendArgs.push(word);
      scanArgs.push(word);
    }
  }
  return { args: sendArgs, scanArgs, credentials: [credential] };
}
