import { prepareCurlArgs } from './secret-curl-args.mjs';
import { prepareGhArgs } from './secret-gh-args.mjs';
import {
  assertSecretFree,
  createPayloadSnapshot,
  readSecretPayload,
  SECRET_PAYLOAD_MAX_BYTES,
} from './secret-payload-files.mjs';

export async function prepareSecretSafeSend(program, args, options = {}) {
  assertSecretFree(args.join('\n'));
  const snapshot = createPayloadSnapshot();
  let stdin;
  const freeze = async (path) => {
    if (path === '-') {
      stdin ??= await (options.readStdin ?? readBoundedStdin)();
      return snapshot.freeze(stdin);
    }
    return snapshot.freeze(readSecretPayload(path, options.cwd), path);
  };
  try {
    const rewritten = program === 'curl' ? await prepareCurlArgs(args, freeze) : await prepareGhArgs(args, freeze);
    return { args: rewritten, dispose: snapshot.dispose };
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
