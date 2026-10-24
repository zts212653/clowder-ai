import { spawn } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatPathFixture } from './chat-path-links.fixture.mjs';
import { stopChild } from './f290-runtime-journey.harness.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const web = fileURLToPath(new URL('../..', import.meta.url)),
  tree = path.resolve(web, '../..');
const fixture = await createChatPathFixture('zh'),
  port = Number(process.env.CHAT_PATH_PREVIEW_PORT ?? 3171);
const environment = await createNextDevTestEnvironment('chat-path-links-preview', {
  NEXT_PUBLIC_API_URL: `http://127.0.0.1:${fixture.apiPort}`,
  API_SERVER_PORT: String(fixture.apiPort),
  FRONTEND_PORT: String(port),
});
const child = spawn(
  process.execPath,
  [
    path.join(web, 'scripts/sync-vendor-assets.mjs'),
    '--watch',
    '--',
    path.join(tree, 'node_modules/next/dist/bin/next'),
    'dev',
    '-H',
    '127.0.0.1',
    '-p',
    String(port),
  ],
  { cwd: web, env: environment.env, stdio: 'inherit' },
);
await mkdir('/tmp/f322-chat-path-links', { recursive: true });
await writeFile(
  '/tmp/f322-chat-path-links/preview.json',
  JSON.stringify({
    port,
    apiPort: fixture.apiPort,
    threadId: fixture.runtime.thread.id,
    messageId: fixture.runtime.message.id,
    root: fixture.runtime.root,
    design: fixture.runtime.design,
  }),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  let exitCode = 0;
  for (const [name, cleanup] of [
    ['web', () => stopChild(child)],
    ['fixture', () => fixture.close()],
    ['build', () => environment.cleanup()],
  ]) {
    try {
      console.log(`Preview cleanup ${name}: starting`);
      await cleanup();
      console.log(`Preview cleanup ${name}: complete`);
    } catch (error) {
      console.error(`Preview cleanup ${name}: ${String(error)}`);
      exitCode = 1;
    }
  }
  const receipt = process.env.CAT_CAFE_PREVIEW_CLEANUP_RESULT;
  if (receipt) {
    const temporary = `${receipt}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, processGroupId: process.pid, exitCode }), {
      mode: 0o600,
    });
    renameSync(temporary, receipt);
  }
  process.exit(exitCode);
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
child.on('exit', () => void close());
console.log(`Preview: http://localhost:${port}/thread/${fixture.runtime.thread.id}?shell=v2`);
