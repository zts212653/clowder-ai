import { prepareCurlArgs } from './secret-curl-args.mjs';
import { prepareGhArgs } from './secret-gh-args.mjs';
import {
  assertSecretFree,
  createPayloadSnapshot,
  readSecretPayload,
  SECRET_PAYLOAD_MAX_BYTES,
} from './secret-payload-files.mjs';
import { assertPlatformSupplementalHeaders, platformCurlAuthentication } from './secret-platform-auth.mjs';

export async function prepareSecretSafeSend(program, args, options = {}) {
  const authentication =
    program === 'curl' ? await platformCurlAuthentication(args) : { scanArgs: args, credentials: [] };
  const check = (content) => {
    if (authentication.credentials.some((key) => Buffer.from(content).includes(Buffer.from(key))))
      throw new Error('secret_content_detected');
    assertSecretFree(content);
  };
  check(authentication.scanArgs.join('\n'));
  const snapshot = createPayloadSnapshot();
  let stdin;
  const freeze = async (path, { headers = false } = {}) => {
    const inspect = (content) => {
      check(content);
      if (headers && authentication.credentials.length) assertPlatformSupplementalHeaders(content);
    };
    if (path === '-') {
      stdin ??= await (options.readStdin ?? readBoundedStdin)();
      inspect(stdin);
      return snapshot.freeze(stdin);
    }
    const content = readSecretPayload(path, options.cwd);
    inspect(content);
    return snapshot.freeze(content, path);
  };
  try {
    const rewritten =
      program === 'curl'
        ? await prepareCurlArgs(authentication.args ?? args, freeze)
        : await prepareGhArgs(args, freeze);
    // Admission validated one literal URL. Curl must not expand it into other transfers/paths.
    // Keep -q first; prepareCurlArgs rejects --no-globoff, so callers cannot undo this.
    if (program === 'curl' && authentication.credentials.length) rewritten.splice(1, 0, '--globoff');
    return { args: rewritten, dispose: snapshot.dispose, credentials: authentication.credentials };
  } catch (error) {
    snapshot.dispose();
    throw error;
  }
}

async function readBoundedStdin() {
  if (process.stdin.isTTY) throw new Error('secret_send_stdin_requires_explicit_content');
  const parts = [];
  let length = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error('secret_send_stdin_timeout')), 5000);
  try {
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > SECRET_PAYLOAD_MAX_BYTES) throw new Error('secret_scan_size_limit');
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  } finally {
    clearTimeout(timer);
  }
}
