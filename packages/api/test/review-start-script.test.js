import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const reviewStartSource = join(repoRoot, 'scripts', 'review-start.sh');
const tempDirs = [];
const servers = [];

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'cc-review-start-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(reviewStartSource, join(root, 'scripts', 'review-start.sh'));
  writeFileSync(
    join(root, 'scripts', 'start-dev.sh'),
    '#!/bin/sh\nprintf "START_DEV:%s/%s\\n" "$FRONTEND_PORT" "$API_SERVER_PORT"\n',
    { mode: 0o755 },
  );

  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'bash'), '#!/bin/sh\nexec /bin/bash "$@"\n', { mode: 0o755 });
  writeFileSync(join(binDir, 'lsof'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  writeFileSync(join(binDir, 'ss'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  writeFileSync(
    join(binDir, 'nc'),
    `#!/bin/bash
if [ "\${1:-}" = "-z" ]; then shift; fi
host="$1"
port="$2"
(exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1
`,
    { mode: 0o755 },
  );

  return { root, binDir };
}

function writeTool(binDir, name, body) {
  writeFileSync(join(binDir, name), body, { mode: 0o755 });
}

function listen(port) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      servers.push(server);
      resolvePromise(server);
    });
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    await new Promise((resolvePromise) => servers.pop().close(resolvePromise));
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('review-start.sh', () => {
  it('dev tcp probe falls back when timeout is unavailable', async () => {
    const { root, binDir } = createSandbox();
    const server = await listen(0);
    const port = server.address().port;
    const scriptPath = join(root, 'scripts', 'review-start.sh');

    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e
source "${scriptPath}" --source-only
PATH="${binDir}"
probe_port_with_dev_tcp "${port}"
printf 'ok'`,
      ],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), 'ok');
  });

  it('nc probe wraps nc with timeout when timeout is available', () => {
    const { root, binDir } = createSandbox();
    const timeoutLog = join(root, 'timeout.log');
    const ncLog = join(root, 'nc.log');
    const scriptPath = join(root, 'scripts', 'review-start.sh');
    writeTool(
      binDir,
      'timeout',
      `#!/bin/bash
printf '%s\\n' "$*" >> "${timeoutLog}"
shift
exec "$@"
`,
    );
    writeTool(
      binDir,
      'nc',
      `#!/bin/bash
printf '%s\\n' "$*" >> "${ncLog}"
exit 0
`,
    );

    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e
source "${scriptPath}" --source-only
PATH="${binDir}"
probe_port_with_nc 6549
printf 'ok'`,
      ],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), 'ok');
    assert.equal(readFileSync(timeoutLog, 'utf8').trim(), '1 nc -z 127.0.0.1 6549');
    assert.equal(readFileSync(ncLog, 'utf8').trim(), '-z 127.0.0.1 6549');
  });

  it('nc probe falls back to bare nc when timeout is unavailable', () => {
    const { root, binDir } = createSandbox();
    const ncLog = join(root, 'nc.log');
    const scriptPath = join(root, 'scripts', 'review-start.sh');
    writeTool(
      binDir,
      'nc',
      `#!/bin/bash
printf '%s\\n' "$*" >> "${ncLog}"
exit 0
`,
    );

    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e
source "${scriptPath}" --source-only
PATH="${binDir}"
probe_port_with_nc 6550
printf 'ok'`,
      ],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), 'ok');
    assert.equal(readFileSync(ncLog, 'utf8').trim(), '-z 127.0.0.1 6550');
  });

  it('falls back when lsof is unavailable and skips occupied review ports', async () => {
    const { root, binDir } = createSandbox();
    const occupiedServer = await listen(0);
    const occupiedPort = occupiedServer.address().port;
    const scriptPath = join(root, 'scripts', 'review-start.sh');
    const script = readFileSync(scriptPath, 'utf8')
      .replace('DEFAULT_WEB_PORT=3201', `DEFAULT_WEB_PORT=${occupiedPort}`)
      .replace('DEFAULT_API_PORT=3202', `DEFAULT_API_PORT=${occupiedPort + 1}`);
    writeFileSync(scriptPath, script, { mode: 0o755 });

    const result = spawnSync('bash', [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        FRONTEND_PORT: '',
        API_SERVER_PORT: '',
        PREVIEW_GATEWAY_PORT: '',
        CAT_CAFE_ALLOW_NON_SANDBOX_REVIEW: '1',
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(`START_DEV:${occupiedPort + 2}/${occupiedPort + 3}`));
  });

  it('rejects documented runtime reserved ports', () => {
    const { root, binDir } = createSandbox();
    const ports = { web: '3003', api: '3004' };

    const result = spawnSync(
      'bash',
      [join(root, 'scripts', 'review-start.sh'), `--web-port=${ports.web}`, '--api-port=3202', '--dry-run'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          FRONTEND_PORT: '',
          API_SERVER_PORT: '',
          PREVIEW_GATEWAY_PORT: '',
          CAT_CAFE_ALLOW_NON_SANDBOX_REVIEW: '1',
        },
      },
    );

    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, new RegExp(`web port .*保留端口: ${ports.web}`));
  });
});
