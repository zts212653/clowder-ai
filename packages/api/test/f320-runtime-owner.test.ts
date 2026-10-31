import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./helpers/f320-runtime-owner-worker.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
interface Observation {
  accountRef: string;
  note: string;
  status: string;
  credentialHome: string;
  stateRoot: string;
  sqliteHome: string;
  accountStore: string;
  executionCwd: string;
  envHome: string;
  authHash: string;
  defaultAuthHash: string;
  sessionHash: string;
  loginCalls: number;
  missing?: boolean;
  unavailable?: Array<{ accountRef: string }>;
  identity: { userId: string; workspaceId: string };
  sessionSource: { sessionId: string; executionAccount: { accountRef: string }; source: string };
}
let root: string, workspace: string, first: string, second: string, staging: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-runtime-owner-')));
  workspace = join(root, 'workspace');
  first = join(root, 'runtime-first');
  second = join(root, 'runtime-next');
  staging = join(root, 'staging-config');
  for (const path of [workspace, first, second, staging, join(root, 'home', '.codex')])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(root, 'home', '.codex', 'auth.json'), '{"fixture_default":"do-not-replace"}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function env(runtime: string, isolated = false): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, 'home'),
    CAT_CAFE_DATA_DIR: join(root, 'data'),
    CAT_CAFE_RUNTIME_ROOT: runtime,
    CAT_CAFE_WORKSPACE_ROOT: workspace,
    CAT_CAFE_CONFIG_ROOT: runtime === first ? staging : runtime,
    AUDIT_LOG_DIR: join(root, 'audit'),
    CAT_CAFE_PROJECT_ALLOWED_ROOTS: root,
  };
  delete output.CODEX_HOME;
  delete output.CODEX_SQLITE_HOME;
  delete output.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  delete output.NODE_TEST_CONTEXT;
  delete output.NODE_OPTIONS;
  if (runtime === first || isolated) output.CAT_CAFE_GLOBAL_CONFIG_ROOT = isolated ? runtime : workspace;
  return output;
}
function run(action: string, runtime: string, ref = '', isolated = false): Observation {
  const raw = execFileSync(process.execPath, ['--import', loader, worker, action, runtime, ref], {
    cwd: runtime,
    env: env(runtime, isolated),
    encoding: 'utf8',
    timeout: 20000,
  });
  const receipt = raw.split('\n').find((line) => line.startsWith('F320_RECEIPT:'));
  assert.ok(receipt, 'worker must emit its structured result separately from application logs');
  return JSON.parse(receipt.slice('F320_RECEIPT:'.length)) as Observation;
}
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('formal workspace account owner survives checkout replacement and fresh API processes without another login', () => {
  // Red mode reproduces the retired preview owner: source and target have separate catalogs.
  const isolated = process.env.F320_HANDOVER_SCOPE === 'isolated';
  const source = run('create', first, '', isolated);
  const target = run('read', second, source.accountRef, isolated);
  console.log(JSON.stringify({ scenario: 'runtime-owner-continuity', source, target }));
  assert.equal(target.missing, undefined, 'replacement runtime must list the same account, not require login again');
  const restarted = run('read', second, source.accountRef, isolated);
  console.log(JSON.stringify({ scenario: 'fresh-api-restart', restarted }));
  for (const observed of [target, restarted]) {
    for (const key of [
      'accountRef',
      'note',
      'status',
      'credentialHome',
      'envHome',
      'stateRoot',
      'sqliteHome',
      'accountStore',
      'authHash',
      'defaultAuthHash',
      'sessionHash',
      'identity',
      'sessionSource',
    ] as const)
      assert.deepEqual(observed[key], source[key], key);
    assert.equal(observed.accountStore, workspace);
    assert.equal(observed.executionCwd, second);
    assert.equal(observed.loginCalls, 0);
    assert.equal(observed.status, 'ready');
    assert.equal(observed.sessionSource.executionAccount.accountRef, source.accountRef);
    assert.equal(observed.sessionSource.source, 'original-checkout');
  }
  assert.equal(source.loginCalls, 1, 'only the source fixture completes its simulated first login');
});

test('conflicting legacy runtime metadata is rejected without overwriting either catalog or credential owner', () => {
  const source = run('create', first);
  const ownerPath = join(workspace, '.cat-cafe', 'accounts.json');
  const accounts = JSON.parse(readFileSync(ownerPath, 'utf8'));
  const legacyPath = join(second, '.cat-cafe', 'accounts.json');
  mkdirSync(join(second, '.cat-cafe'), { recursive: true });
  writeFileSync(
    legacyPath,
    JSON.stringify({
      [source.accountRef]: {
        ...accounts[source.accountRef],
        displayName: 'conflicting legacy fixture',
      },
    }),
  );
  const before = [hash(ownerPath), hash(legacyPath), source.authHash, source.defaultAuthHash];
  const target = run('read', second, source.accountRef);
  assert.equal(target.missing, true);
  assert.ok(target.unavailable?.some((entry) => entry.accountRef === source.accountRef));
  assert.deepEqual(
    [
      hash(ownerPath),
      hash(legacyPath),
      hash(join(source.credentialHome, 'auth.json')),
      hash(join(source.stateRoot, 'auth.json')),
    ],
    before,
  );
  assert.equal(target.loginCalls, 0);
  console.log(
    JSON.stringify({
      scenario: 'catalog-conflict',
      accountRef: source.accountRef,
      sourceStore: workspace,
      targetLegacyStore: second,
      unavailable: target.unavailable,
      preservedHashes: before,
    }),
  );
});

test('premerge account testing changes only the staging member catalog, not formal runtime bindings', () => {
  const catalog = {
    version: 2,
    breeds: [
      {
        id: 'fixture',
        catId: 'f320-test-cat',
        name: '缅因猫',
        displayName: '缅因猫',
        avatar: '/avatars/codex.png',
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: ['@f320-test-cat'],
        roleDescription: 'fixture',
        defaultVariantId: 'fixture-default',
        variants: [
          {
            id: 'fixture-default',
            catId: 'f320-test-cat',
            clientId: 'openai',
            defaultModel: 'fixture',
            accountRef: 'codex',
            mcpSupport: true,
            mentionPatterns: ['@f320-test-cat'],
            cli: { command: 'codex', outputFormat: 'json' },
          },
        ],
      },
    ],
    roster: {
      'f320-test-cat': { family: 'maine', roles: ['assistant'], lead: false, available: true, evaluation: 'fixture' },
    },
    reviewPolicy: {
      requireDifferentFamily: false,
      preferActiveInThread: false,
      preferLead: false,
      excludeUnavailable: true,
    },
    coCreator: { name: 'Owner', aliases: ['Owner'], mentionPatterns: ['@owner'] },
  };
  for (const path of [workspace, staging]) {
    mkdirSync(join(path, '.cat-cafe'));
    writeFileSync(join(path, 'cat-template.json'), JSON.stringify(catalog));
    writeFileSync(join(path, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(catalog));
  }
  const formalPath = join(workspace, '.cat-cafe', 'cat-catalog.json');
  const before = hash(formalPath);
  const source = run('create', first);
  const result = run('bind-stage', first, source.accountRef) as unknown as { status: number };
  assert.equal(result.status, 200);
  const updated = JSON.parse(readFileSync(join(staging, '.cat-cafe', 'cat-catalog.json'), 'utf8'));
  assert.equal(updated.breeds[0].variants[0].accountRef, source.accountRef);
  assert.equal(hash(formalPath), before);
  assert.equal(run('read', second, source.accountRef).credentialHome, source.credentialHome);
  console.log(
    JSON.stringify({
      scenario: 'binding-isolation',
      sharedAccountStore: workspace,
      stagingCatalog: staging,
      preservedFormalCatalogHash: before,
    }),
  );
});

test('another checkout cannot steal a live login owner or change its accepted account', async () => {
  const source = run('create', first);
  const holder = spawn(process.execPath, ['--import', loader, worker, 'hold', first, source.accountRef], {
    cwd: first,
    env: env(first),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('fixture owner did not start')), 20000);
      let text = '';
      holder.stdout.on('data', (data) => {
        text += String(data);
        if (text.includes('"state":"held"')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      holder.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`fixture owner exited ${code}`));
      });
    });
    const path = join(workspace, '.cat-cafe', 'accounts.json');
    const before = hash(path);
    const refusal = run('refuse-live', second, source.accountRef) as unknown as {
      status: number;
      error: string;
      loginCalls: number;
    };
    assert.equal(refusal.status, 409);
    assert.equal(refusal.error, 'codex_login_owned_by_live_service');
    assert.equal(refusal.loginCalls, 0);
    assert.equal(hash(path), before);
    assert.equal(hash(join(source.credentialHome, 'auth.json')), source.authHash);
    assert.equal(hash(join(source.stateRoot, 'auth.json')), source.defaultAuthHash);
    console.log(
      JSON.stringify({
        scenario: 'live-owner-refusal',
        accountRef: source.accountRef,
        sourceCheckout: first,
        targetCheckout: second,
        refusal,
        preservedCatalogHash: before,
      }),
    );
  } finally {
    const exited =
      holder.exitCode !== null || holder.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    holder.stdin.end('stop\n');
    const killTimer = setTimeout(() => holder.kill('SIGTERM'), 2000);
    await exited;
    clearTimeout(killTimer);
  }
});
