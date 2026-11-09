#!/usr/bin/env node
import { dirname, resolve } from 'node:path';

const usage = 'node scripts/platform-request.mjs --request FILE [--file-root DIR] [--output-dir DIR]';
const allowed = new Set(['--request', '--file-root', '--output-dir']);
const flags = new Map();
let sendRef = null;
const write = (stream, value) =>
  new Promise((resolve, reject) => stream.write(`${value}\n`, (error) => (error ? reject(error) : resolve())));
try {
  for (let index = 2; index < process.argv.length; index++) {
    const name = process.argv[index];
    if (name === '--help' && process.argv.length === 3) {
      console.log(usage);
      process.exit(0);
    }
    if (!allowed.has(name) || flags.has(name)) throw new Error('Invalid CLI arguments');
    const value = process.argv[++index];
    if (!value || value.startsWith('--')) throw new Error('Missing CLI argument');
    flags.set(name, value);
  }
  const requestPath = flags.get('--request');
  if (!requestPath) throw new Error('Missing request file');
  // Machine-readable stdout is only the receipt. The shared audit writer still persists its events.
  process.env.LOG_LEVEL = 'silent';
  const [{ createPlatformInputReader }, { platformAccountProjectRoot }, { executeOpenAIPlatformRequest }] =
    await Promise.all([
      import('../packages/api/dist/domains/services/openai-platform/input-files.js'),
      import('../packages/api/dist/config/platform-authentication.js'),
      import('../packages/api/dist/domains/services/openai-platform/request.js'),
    ]);
  const projectRoot = platformAccountProjectRoot();
  const reader = createPlatformInputReader({ projectRoot, fileRoot: dirname(resolve(requestPath)), credentials: [] });
  const input = JSON.parse(reader.read(resolve(requestPath)).toString('utf8'));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const receipt = await executeOpenAIPlatformRequest(
      {
        projectRoot,
        fileRoot: resolve(flags.get('--file-root') ?? dirname(resolve(requestPath))),
        ...(flags.has('--output-dir') ? { outputDir: resolve(flags.get('--output-dir')) } : {}),
        signal: controller.signal,
        onSend: (ref) => {
          sendRef = ref;
        },
      },
      input,
    );
    await write(process.stdout, JSON.stringify(receipt));
    process.exitCode = receipt.status === 'completed' ? 0 : receipt.status === 'http_error' ? 2 : 3;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
} catch (error) {
  await write(
    process.stderr,
    JSON.stringify({
      status: sendRef ? 'unconfirmed' : 'not_sent',
      code: sendRef
        ? 'receipt_unavailable'
        : error?.code === 'platform_account_unavailable'
          ? error.code
          : 'admission_failed',
      ...(sendRef ?? {}),
      error: sendRef
        ? 'Platform request could not return a receipt; inspect the callId audit before repeating a potentially charged request'
        : error?.code === 'platform_account_unavailable'
          ? 'Selected OpenAI Platform API key account is unavailable; check the Hub account configuration. No request was sent.'
          : `Request input, installation or output admission failed; no request was sent. Usage: ${usage}`,
    }),
  );
  process.exitCode = 1;
}
