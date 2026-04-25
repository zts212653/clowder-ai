import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// F171: bootstrapCatCatalog now creates empty catalogs. To start the API server in tests,
// we must provide a pre-seeded cat-catalog.json with breeds so getCatModel('opus') succeeds.
const BUILTIN_ACCOUNT_IDS = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  kimi: 'kimi',
  dare: 'dare',
  opencode: 'opencode',
};

function buildSeededCatalog(templatePath) {
  const template = JSON.parse(readFileSync(templatePath, 'utf-8'));
  const version = template.version ?? 1;
  const breeds = JSON.parse(JSON.stringify(template.breeds || []));
  for (const breed of breeds) {
    for (const variant of breed.variants || []) {
      if (!variant.accountRef && variant.clientId && BUILTIN_ACCOUNT_IDS[variant.clientId]) {
        variant.accountRef = BUILTIN_ACCOUNT_IDS[variant.clientId];
      }
    }
  }
  const roster = template.roster ?? {};
  const reviewPolicy = template.reviewPolicy ?? {
    requireDifferentFamily: true,
    preferActiveInThread: true,
    preferLead: true,
    excludeUnavailable: true,
  };
  return version >= 2
    ? { version, breeds, roster, reviewPolicy, ...(template.coCreator ? { coCreator: template.coCreator } : {}) }
    : { version, breeds };
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function waitForMatch(child, regex, { timeoutMs }) {
  let output = '';
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeoutMs);

  const onData = (chunk) => {
    output += chunk.toString();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  try {
    while (!timedOut) {
      const match = output.match(regex);
      if (match) {
        return { match, output };
      }
      // avoid busy loop
      await delay(25);
    }
    const tail = output.split('\n').filter(Boolean).slice(-20).join('\n');
    throw new Error(`Timed out waiting for output matching ${regex}\n--- child output tail ---\n${tail}`);
  } finally {
    clearTimeout(timeout);
    child.stdout?.off('data', onData);
    child.stderr?.off('data', onData);
  }
}

async function canBindLoopback() {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code === 'EPERM' || code === 'EACCES') {
        resolve(false);
      } else {
        resolve(true);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

test('API binds to 127.0.0.1 by default', async (t) => {
  if (!(await canBindLoopback())) {
    t.skip('Environment blocks 127.0.0.1 bind (sandbox EPERM/EACCES). Run this test outside sandbox.');
    return;
  }

  const apiDir = path.resolve(process.cwd());
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'security-boundary-'));
  // F171: provide a seeded catalog so the spawned API server can resolve cat models.
  // The template lives 3 levels up from this test file (packages/api/test → repo root).
  const repoTemplatePath = path.resolve(__dirname, '..', '..', '..', 'cat-template.json');
  const templateForServer = path.join(tempRoot, 'cat-template.json');
  writeFileSync(templateForServer, readFileSync(repoTemplatePath, 'utf-8'), 'utf-8');
  mkdirSync(path.join(tempRoot, '.cat-cafe'), { recursive: true });
  writeFileSync(
    path.join(tempRoot, '.cat-cafe', 'cat-catalog.json'),
    `${JSON.stringify(buildSeededCatalog(repoTemplatePath), null, 2)}\n`,
    'utf-8',
  );

  const childEnv = {
    ...process.env,
    CAT_TEMPLATE_PATH: templateForServer,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: tempRoot,
    API_SERVER_PORT: '0',
    MEMORY_STORE: '1',
    PREVIEW_GATEWAY_ENABLED: '0',
    PREVIEW_GATEWAY_PORT: '0',
    DOCS_ROOT: tempRoot,
    EVIDENCE_DB: path.join(tempRoot, 'evidence.sqlite'),
  };
  delete childEnv.API_SERVER_HOST;
  delete childEnv.REDIS_URL;
  delete childEnv.CAT_CAFE_REDIS_TEST_ISOLATED;

  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: apiDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.once('error', (err) => {
    throw err;
  });

  try {
    const { match } = await waitForMatch(child, /Server (?:listening at|running on) http:\/\/([^:]+):(\d+)/, {
      timeoutMs: 15000,
    });

    const host = match[1];
    const port = Number(match[2]);

    assert.equal(host, '127.0.0.1');
    assert.ok(Number.isInteger(port) && port > 0);

    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(2000)]);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
