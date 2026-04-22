import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

function createSandbox({ ncScript } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cc-review-start-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(reviewStartSource, join(root, 'scripts', 'review-start.sh'));
  writeFileSync(
    join(root, 'scripts', 'start-entry.mjs'),
    `console.log(\`START_ENTRY:\${process.env.FRONTEND_PORT}/\${process.env.API_SERVER_PORT}\`);\n`,
  );

  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'lsof'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  writeFileSync(join(binDir, 'ss'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  writeFileSync(
    join(binDir, 'nc'),
    ncScript ??
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

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      servers.push(server);
      resolve(server);
    });
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    await new Promise((resolve) => servers.pop().close(resolve));
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('review-start.sh', () => {
  it('falls back when lsof is unavailable and skips occupied review ports', async () => {
    const { root, binDir } = createSandbox();
    await listen(3201);

    const result = spawnSync('bash', [join(root, 'scripts', 'review-start.sh')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        FRONTEND_PORT: '',
        API_SERVER_PORT: '',
        PREVIEW_GATEWAY_PORT: '',
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Frontend port: 3211/);
    assert.match(result.stdout, /API port:\s+3212/);
    assert.match(result.stdout, /START_ENTRY:3211\/3212/);
  });

  it('continues to bash TCP fallback when nc is present but cannot probe', async () => {
    const { root, binDir } = createSandbox({
      ncScript: '#!/bin/sh\nexit 1\n',
    });
    await listen(3201);

    const result = spawnSync('bash', [join(root, 'scripts', 'review-start.sh')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        FRONTEND_PORT: '',
        API_SERVER_PORT: '',
        PREVIEW_GATEWAY_PORT: '',
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Frontend port: 3211/);
    assert.match(result.stdout, /API port:\s+3212/);
    assert.match(result.stdout, /START_ENTRY:3211\/3212/);
  });
});
