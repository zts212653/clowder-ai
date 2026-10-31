import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startLayoutModel } from './helpers/f320-layout-model.mjs';
import { startLayoutHost, waitUntil } from './helpers/f320-layout-rpc.mjs';

// Standalone native fixture: only temporary homes and an unauthenticated loopback provider.
const root = await realpath(await mkdtemp('/tmp/f320-layout-'));
const binary = process.argv[2] ?? 'codex';
const report = {
  sourceCommit: '687a119f0fcaace47e1f1abcc77cec6c813fd6da',
  root,
  scope: 'isolated homes; no real credentials/login/default daemon/Keychain',
  results: {},
};
const hosts = [];
const model = await startLayoutModel();
try {
  report.version = execFileSync(binary, ['--version'], {
    env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root },
    encoding: 'utf8',
  }).trim();
  assert.equal(report.version, 'codex-cli 0.159.0', 'revalidate fixture on a new installed version');
  const state = join(root, 'state');
  const aHome = join(root, 'a'),
    bHome = join(root, 'b');
  await mkdir(state);
  const sharedDirectories = ['sessions', 'archived_sessions', 'thread-writer-locks', 'memories', 'memories_v2'];
  for (const dir of sharedDirectories) await mkdir(join(state, dir));
  await writeFile(join(state, 'memories_v2', 'memory_summary.md'), 'v1\nF320_NATIVE_MEMORY\n');
  const config = `cli_auth_credentials_store="file"\nmodel="fixture"\nmodel_provider="fixture"\n[features]\nrespect_system_proxy=false\nsystem_proxy_fallback=false\nenable_request_compression=false\n[model_providers.fixture]\nname="Fixture"\nbase_url=${JSON.stringify(model.url)}\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n`;
  const memoryConfig = config.replace(
    '[features]',
    '[memories]\nversion="v2"\ngenerate_memories=false\nuse_memories=true\n[features]\nmemory_tool=true',
  );
  await writeFile(join(state, 'config.toml'), memoryConfig);
  for (const home of [aHome, bHome]) {
    await mkdir(home);
    for (const dir of sharedDirectories) await symlink(join(state, dir), join(home, dir));
    await symlink(join(state, 'config.toml'), join(home, 'config.toml'));
  }
  const launch = async (home, name) => {
    const host = await startLayoutHost(binary, home, state, root, name);
    hosts.push(host);
    return host;
  };
  const a = await launch(aHome, 'A'),
    b = await launch(bHome, 'B');
  const started = await a.rpc('thread/start', {
    cwd: root,
    model: 'fixture',
    modelProvider: 'fixture',
    approvalPolicy: 'never',
    sandbox: 'read-only',
  });
  const uuid = started.thread.id;
  await a.rpc('turn/start', { threadId: uuid, input: [{ type: 'text', text: 'LOCAL_LAYOUT_SENTINEL' }] });
  await waitUntil(() => a.events.some((event) => event.method === 'turn/completed' && event.params.threadId === uuid));
  await a.rpc('thread/goal/set', { threadId: uuid, objective: 'F320_NATIVE_GOAL', status: 'paused' });
  const resume = {
    threadId: uuid,
    cwd: root,
    model: 'fixture',
    modelProvider: 'fixture',
    approvalPolicy: 'never',
    sandbox: 'read-only',
  };
  await assert.rejects(b.rpc('thread/resume', resume), /active writer|WouldBlock|already.*writer/i);
  report.results.L1 = {
    secondWriterRejected: true,
    sharedLockRoot:
      (await realpath(join(aHome, 'thread-writer-locks'))) === (await realpath(join(bHome, 'thread-writer-locks'))),
  };
  await a.stop();
  assert.equal((await b.rpc('thread/resume', resume)).thread.id, uuid);
  const historyB = (await b.rpc('thread/read', { threadId: uuid, includeTurns: true })).thread;
  assert.match(JSON.stringify(historyB), /LOCAL_LAYOUT_SENTINEL/);
  assert.equal((await b.rpc('thread/goal/get', { threadId: uuid })).goal.objective, 'F320_NATIVE_GOAL');
  report.results.L2 = { uuid, afterReleaseResumed: true, historyVisibleInB: true };
  report.results.L2.nativeGoalVisibleInB = true;
  const bTurn = await b.rpc('turn/start', { threadId: uuid, input: [{ type: 'text', text: 'CONTINUITY_B' }] });
  await waitUntil(() =>
    b.events.some((event) => event.method === 'turn/completed' && event.params.turn.id === bTurn.turn.id),
  );
  assert.equal(model.requests.at(-1).nativeMemory, true, 'native v2 memory must reach the model after changing home');
  report.results.L2.nativeMemoryInB = true;
  const listed = await b.rpc('thread/list', { limit: 1 });
  assert.equal(
    listed.data.some((thread) => thread.id === uuid),
    true,
  );
  await b.rpc('thread/revert', { threadId: uuid, beforeTurnId: bTurn.turn.id });
  const rolledBack = await b.rpc('thread/read', { threadId: uuid, includeTurns: true });
  assert.doesNotMatch(JSON.stringify(rolledBack), /CONTINUITY_B/);
  await b.rpc('thread/archive', { threadId: uuid });
  await b.rpc('thread/unarchive', { threadId: uuid });
  report.results.L2.listRevertArchive = true;
  await b.stop();
  const restartedA = await launch(aHome, 'A2');
  assert.equal((await restartedA.rpc('thread/resume', resume)).thread.id, uuid);
  assert.match(
    JSON.stringify(await restartedA.rpc('thread/read', { threadId: uuid, includeTurns: true })),
    /LOCAL_LAYOUT_SENTINEL/,
  );
  assert.equal((await restartedA.rpc('thread/goal/get', { threadId: uuid })).goal.objective, 'F320_NATIVE_GOAL');
  report.results.L2.coldAtoBtoA = true;
  report.results.L2.sqliteFiles = (await readdir(state)).filter((name) => /_\d+\.sqlite$/.test(name)).sort();
  assert.deepEqual(report.results.L2.sqliteFiles, [
    'goals_1.sqlite',
    'logs_2.sqlite',
    'memories_1.sqlite',
    'memories_v2_1.sqlite',
    'queue_1.sqlite',
    'state_5.sqlite',
    'thread_history_1.sqlite',
  ]);
  // Native config writer resolves the symlink target before its atomic replacement.
  await restartedA.rpc('config/value/write', {
    keyPath: 'model_reasoning_effort',
    value: 'low',
    mergeStrategy: 'replace',
  });
  const nativeConfig = await readFile(join(aHome, 'config.toml'), 'utf8');
  assert.match(nativeConfig, /model_reasoning_effort\s*=\s*"low"/);
  assert.equal(nativeConfig, await readFile(join(bHome, 'config.toml'), 'utf8'));
  assert.equal(await realpath(join(aHome, 'config.toml')), join(state, 'config.toml'));
  report.results.L4 = { nativeValueWritePreservesSharedTarget: true };
  await restartedA.stop();
  // Mock keyring reproduces the pinned native namespace formulas, never calls macOS keyring.
  const namespace = (home) => createHash('sha256').update(home).digest('hex').slice(0, 16);
  const mockKeyring = new Map();
  const identities = [];
  for (const [home, label] of [
    [aHome, 'A'],
    [bHome, 'B'],
  ]) {
    const canonical = await realpath(home);
    const key = `cli|${namespace(canonical)}`;
    const secretsKey = `secrets|${namespace(canonical)}`;
    mockKeyring.set(key, `fixture-${label}`);
    identities.push({ key, secretsKey, control: join(canonical, 'app-server-control') });
    await mkdir(join(home, 'secrets'));
    await writeFile(join(home, 'auth.json'), `fixture-${label}`);
    await writeFile(join(home, '.credentials.json'), `fixture-MCP-${label}`);
    await writeFile(join(home, 'secrets', 'codex_auth.age'), `fixture-ciphertext-${label}`);
  }
  assert.notEqual(identities[0].key, identities[1].key);
  assert.notEqual(identities[0].secretsKey, identities[1].secretsKey);
  assert.notEqual(identities[0].control, identities[1].control);
  assert.equal(mockKeyring.get(identities[0].key), 'fixture-A');
  assert.equal(await readFile(join(aHome, 'auth.json'), 'utf8'), 'fixture-A');
  report.results.L3 = {
    separateFileStores: true,
    distinctNativeNamespaceFormulas: true,
    mockKeyringOnly: true,
    notMeasured: ['native encrypted-secrets roundtrip', 'enterprise/gateway authorization behavior'],
  };
  // Counterexample: rename through a shared config symlink replaces that link, forking live configuration.
  await writeFile(join(aHome, 'config.tmp'), memoryConfig + '\n# A-only replacement\n');
  await rename(join(aHome, 'config.tmp'), join(aHome, 'config.toml'));
  report.results.L4 = {
    ...report.results.L4,
    naiveSharedConfigSymlinkRejected:
      (await readFile(join(aHome, 'config.toml'), 'utf8')) !== (await readFile(join(bHome, 'config.toml'), 'utf8')),
  };
  assert.equal(report.results.L4.naiveSharedConfigSymlinkRejected, true);
  report.results.L5 = {
    status: 'unverified',
    blocker: 'native compaction marker/publication coordination with separate .tmp; sandbox realpath access',
  };
  report.results.L6 = {
    status: 'unverified',
    blocker: 'historical image/attachment source paths and native history/plugin consumers across account homes',
  };
  assert.equal(model.requests.length > 0, true);
  assert.equal(
    model.requests.some((request) => request.authorization),
    false,
  );
  report.noAuthorizationHeader = true;
} catch (error) {
  report.error = error.message;
  report.localRequests = model.requests;
  report.events = hosts.map((host) => ({ events: host.events.slice(-8), stderr: host.diagnostic() }));
  throw error;
} finally {
  await Promise.allSettled(hosts.map((host) => host.stop()));
  await model.close();
  const output = process.argv[3];
  if (output) await writeFile(output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      version: report.version,
      results: report.results,
      error: report.error,
      noAuthorizationHeader: report.noAuthorizationHeader,
    }),
  );
  await rm(root, { recursive: true, force: true });
}
