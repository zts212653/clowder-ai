import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReplayFixture } from './f322-replay-fixture.mjs';

const fixture = createReplayFixture();
const api = createServer(fixture.handler);
await new Promise((resolve, reject) => {
  api.once('error', reject);
  api.listen(51185, '127.0.0.1', resolve);
});
const web = spawn('pnpm', ['--filter', '@cat-cafe/web', 'exec', 'next', 'dev', '-p', '51184'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NEXT_PUBLIC_API_URL: 'http://localhost:51185',
    NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION: process.env.REPLAY_PREVIEW_REVISION,
  },
});
let closing = false;
function close(signal) {
  if (closing) return;
  closing = true;
  web.kill(signal);
  api.close();
}
process.on('SIGTERM', () => close('SIGTERM'));
process.on('SIGINT', () => close('SIGINT'));
web.on('exit', (code) => {
  api.close();
  process.exitCode = code ?? 1;
});
