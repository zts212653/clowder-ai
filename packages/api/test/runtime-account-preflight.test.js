import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import * as preflight from '../dist/config/runtime-account-preflight.js';

const keys = ['CAT_CAFE_RUNTIME_ROOT', 'CAT_CAFE_WORKSPACE_ROOT', 'CAT_CAFE_GLOBAL_CONFIG_ROOT', 'CAT_TEMPLATE_PATH'];
const oauth = { authType: 'oauth', models: ['fixture'] };
let root, workspace, runtime, saved;
const put = (dir, name, value) => writeFileSync(join(dir, '.cat-cafe', name), JSON.stringify(value));

function catalog(bindings = { healthy: 'codex', broken: 'claude' }, unavailable = []) {
  const config = {
    version: 2,
    breeds: Object.entries(bindings).map(([catId, accountRef]) => ({
      id: `${catId}-breed`,
      catId,
      name: catId,
      displayName: catId,
      avatar: '/avatars/opus.png',
      color: { primary: '#111111', secondary: '#eeeeee' },
      mentionPatterns: [`@${catId}`],
      roleDescription: 'fixture',
      defaultVariantId: `${catId}-variant`,
      variants: [
        { id: `${catId}-variant`, clientId: 'anthropic', accountRef, defaultModel: 'fixture', mcpSupport: true },
      ],
    })),
    roster: Object.fromEntries(
      unavailable.map((id) => [
        id,
        {
          family: `${id}-breed`,
          roles: ['member'],
          lead: false,
          available: false,
          evaluation: 'fixture',
        },
      ]),
    ),
    reviewPolicy: {
      requireDifferentFamily: true,
      preferActiveInThread: true,
      preferLead: true,
      excludeUnavailable: true,
    },
  };
  writeFileSync(join(runtime, 'cat-template.json'), JSON.stringify(config));
  put(runtime, 'cat-catalog.json', config);
  return config;
}

beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), 'runtime-account-check-'));
  workspace = join(root, 'workspace');
  runtime = join(root, 'runtime');
  for (const dir of [workspace, runtime]) mkdirSync(join(dir, '.cat-cafe'), { recursive: true });
  process.env.CAT_CAFE_RUNTIME_ROOT = runtime;
  process.env.CAT_CAFE_WORKSPACE_ROOT = workspace;
  delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_TEMPLATE_PATH = join(runtime, 'cat-template.json');
  put(workspace, 'accounts.json', { claude: oauth, codex: oauth });
  put(runtime, 'accounts.json', { claude: { ...oauth, models: ['new-model'] }, codex: oauth });
  catalog();
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test('models-only divergence is attributed to the bound member, without changing either store', () => {
  const paths = [
    join(workspace, '.cat-cafe/accounts.json'),
    join(runtime, '.cat-cafe/accounts.json'),
    join(runtime, '.cat-cafe/cat-catalog.json'),
  ];
  const before = paths.map((path) => readFileSync(path, 'utf8'));
  const result = preflight.inspectRuntimeAccountBindings(runtime);
  assert.equal(result.checkedBindings, 2);
  assert.deepEqual(
    result.rejectedBindings.map(({ catId, accountRef }) => [catId, accountRef]),
    [['broken', 'claude']],
  );
  assert.match(result.rejectedBindings[0].reason, /divergent/);
  assert.deepEqual(
    paths.map((path) => readFileSync(path, 'utf8')),
    before,
  );
});

test('inactive and unbound rejected accounts remain advisory', () => {
  catalog({ healthy: 'codex', broken: 'claude', unbound: undefined }, ['broken']);
  const result = preflight.inspectRuntimeAccountBindings(runtime);
  assert.equal(result.checkedBindings, 1);
  assert.deepEqual(result.rejectedBindings, []);
  assert.equal(result.unboundRejectedAccounts[0].accountRef, 'claude');
});

test('missing custom metadata is rejected but absent builtin OAuth and unbound CLIs retain their contract', () => {
  catalog({ custom: 'not-installed', builtin: 'gemini', unbound: undefined });
  const result = preflight.inspectRuntimeAccountBindings(runtime);
  assert.deepEqual(
    result.rejectedBindings.map(({ catId }) => catId),
    ['custom'],
  );
});

test('catalog account residuals participate in the canonical verdict', () => {
  put(runtime, 'accounts.json', { codex: oauth });
  const config = catalog();
  config.accounts = { claude: { ...oauth, models: ['catalog-only-model'] } };
  put(runtime, 'cat-catalog.json', config);
  assert.match(preflight.inspectRuntimeAccountBindings(runtime).rejectedBindings[0].reason, /divergent/);
});

test('the actual inspector consumes legacy bindings without persisting their migration', () => {
  const config = catalog();
  const variant = config.breeds[1].variants[0];
  variant.provider = variant.clientId;
  variant.providerProfileId = variant.accountRef;
  delete variant.clientId;
  delete variant.accountRef;
  put(runtime, 'cat-catalog.json', config);
  const path = join(runtime, '.cat-cafe/cat-catalog.json');
  const before = readFileSync(path, 'utf8');
  assert.deepEqual(
    preflight.inspectRuntimeAccountBindings(runtime).rejectedBindings.map(({ catId }) => catId),
    ['broken'],
  );
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('credential-only refs remain rejected even when the other root has matching metadata', () => {
  put(workspace, 'accounts.json', { codex: oauth });
  put(workspace, 'credentials.json', { claude: { apiKey: 'FAKE_ORPHAN_KEY' } });
  put(runtime, 'credentials.json', { claude: { apiKey: 'FAKE_ORPHAN_KEY' } });
  const result = preflight.inspectRuntimeAccountBindings(runtime);
  assert.match(result.rejectedBindings[0].reason, /torn credential without account metadata/);
  assert.doesNotMatch(JSON.stringify(result), /FAKE_ORPHAN_KEY/);
});

test('first install does not turn template menu entries into active bindings', () => {
  rmSync(join(runtime, '.cat-cafe/cat-catalog.json'));
  assert.equal(preflight.inspectRuntimeAccountBindings(runtime).checkedBindings, 0);
});

test('an explicit global root is consumed consistently with production topology', () => {
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = workspace;
  assert.deepEqual(preflight.inspectRuntimeAccountBindings(runtime).rejectedBindings, []);
});

for (const [name, live, expected] of [
  ['legacy live build', { state: 'legacy' }, ['broken']],
  ['existing rejection', { state: 'current', rejectedAccountRefs: ['claude'] }, []],
  ['new rejection', { state: 'current', rejectedAccountRefs: ['codex'] }, ['broken']],
  ['unreachable live API', { state: 'unreachable' }, []],
]) {
  test(`replacement comparison: ${name}`, () => {
    const result = preflight.inspectRuntimeAccountBindings(runtime);
    assert.deepEqual(
      preflight.newlyRejectedRuntimeBindings(result, live).map(({ catId }) => catId),
      expected,
    );
  });
}

async function runChecker(args) {
  // The CLI is a production diagnostic, not a nested `node --test`. Inherit the
  // parent NODE_TEST_CONTEXT / CAT_CAFE_TEST_SANDBOX and the fixture roots are
  // snapshotted as "inherited from the launching process" at module load, so
  // the read guard refuses the very tmpdirs this suite owns (P1-8 false positive).
  // Mirror account-store-read-boundary's childEnv: delete test markers, keep the
  // explicit fixture roots the CLI is meant to inspect.
  const env = {
    ...process.env,
    CAT_CAFE_RUNTIME_ROOT: runtime,
    CAT_CAFE_WORKSPACE_ROOT: workspace,
    // cat-config-loader pulls infrastructure/logger, which redirects console.* to
    // pino JSON on stdout. Suppress process warnings so --json stays one line.
    NODE_NO_WARNINGS: '1',
  };
  for (const key of [
    'NODE_TEST_CONTEXT',
    'CAT_CAFE_TEST_SANDBOX',
    'CAT_CAFE_TEST_REAL_HOME',
    'CAT_CAFE_TEST_SANDBOX_ROOT',
    'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT',
    'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    'FORCE_COLOR',
  ]) {
    delete env[key];
  }
  const child = spawn(process.execPath, [resolve('dist/scripts/runtime-account-preflight/cli.js'), ...args], {
    env,
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((done, reject) => {
    child.on('error', reject);
    child.on('close', done);
  });
  return { status, stdout, stderr };
}

/** Prefer the preflight report line if logger noise still lands on stdout. */
function parseCheckerReport(stdout) {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(lines[i]);
      if (value && typeof value === 'object' && 'checkedBindings' in value) return value;
    } catch {
      // keep scanning
    }
  }
  throw new Error(`no preflight JSON report in stdout:\n${stdout}`);
}

for (const [name, body, expected] of [
  ['legacy API', { providers: [] }, 2],
  ['already rejected', { providers: [], unavailableAccounts: [{ accountRef: 'claude' }] }, 0],
  ['healthy live binding', { providers: [], unavailableAccounts: [] }, 2],
  ['malformed API', { other: true }, 0],
]) {
  test(`real checker probes ${name} and returns ${expected}`, async () => {
    const server = createServer((request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/api/accounts');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    try {
      const result = await runChecker(['--api-port', String(server.address().port), '--json']);
      assert.equal(result.status, expected, result.stderr);
      const report = parseCheckerReport(result.stdout);
      assert.equal(report.rejectedBindings.length, 1);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
}

test('explicit regression acceptance changes only the exit decision, retaining the affected member report', async () => {
  const server = createServer((_request, response) => {
    response.end(JSON.stringify({ providers: [], unavailableAccounts: [] }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const result = await runChecker([
      '--api-port',
      String(server.address().port),
      '--allow-account-regression',
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = parseCheckerReport(result.stdout);
    assert.equal(report.allowRegression, true);
    assert.equal(report.blocked, false);
    assert.deepEqual(
      report.newRejections.map(({ catId }) => catId),
      ['broken'],
    );
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('cold startup without a listening API warns and retains partial availability', async () => {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  const result = await runChecker(['--api-port', String(port)]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /cold start or failed probe/);
  assert.match(result.stderr, /broken/);
});

test('a redirect is unknown and is never followed to another endpoint', async () => {
  const urls = [];
  const server = createServer((request, response) => {
    urls.push(request.url);
    response.writeHead(302, { location: '/elsewhere' });
    response.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    assert.deepEqual(await preflight.readLiveAccountAvailability(server.address().port), { state: 'unreachable' });
    assert.deepEqual(urls, ['/api/accounts']);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('a hung live API times out as unknown instead of indefinitely blocking recovery', async () => {
  const server = createServer(() => {});
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const started = Date.now();
  try {
    assert.deepEqual(await preflight.readLiveAccountAvailability(server.address().port), { state: 'unreachable' });
    assert.ok(Date.now() - started < 5000);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test('credential conflict diagnostics never disclose the credential contents', async () => {
  put(workspace, 'credentials.json', { claude: { apiKey: 'FAKE_SECRET_A_DO_NOT_PRINT' } });
  put(runtime, 'credentials.json', { claude: { apiKey: 'FAKE_SECRET_B_DO_NOT_PRINT' } });
  const result = await runChecker(['--json']);
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /FAKE_SECRET/);
});
