import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { validateCodexOAuthConfig } from '../../config/codex-account-environment.js';
import { type Check, expect, record, type Socket } from './probe-check.js';
import { type ProbeHost, probePath, startProbeHost, startProbeModel, waitUntil } from './probe-host.js';

const MEMORY_MARKER = 'CAT_CAFE_COMPAT_NATIVE_MEMORY';
const SHARED_DIRECTORIES = ['sessions', 'archived_sessions', 'thread-writer-locks', 'memories', 'memories_v2'];
const run = promisify(execFile);

async function sqliteFilesOutsideSharedRoot(home: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await walk(path);
      else if (/\.sqlite$/.test(entry)) found.push(path);
    }
  };
  await walk(home);
  return found;
}

/** F320 file auth: a managed home whose private login disappears must not borrow the host login. */
async function probeNoHostLoginFallback(binary: string, root: string, check: Check): Promise<void> {
  const hostHome = join(root, 'host');
  const privateHome = join(root, 'private');
  await mkdir(join(hostHome, '.codex'), { recursive: true });
  await mkdir(privateHome);
  const claims = { chatgpt_user_id: 'probe-user', chatgpt_account_id: 'probe-workspace', chatgpt_plan_type: 'pro' };
  const idToken = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': claims })).toString('base64url')}.x`;
  const login = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: idToken,
      account_id: 'probe-workspace',
      access_token: 'probe-access',
      refresh_token: 'probe-refresh',
    },
    last_refresh: new Date().toISOString(),
  });
  await writeFile(join(hostHome, '.codex', 'auth.json'), login, { mode: 0o600 });
  await writeFile(join(privateHome, 'auth.json'), login, { mode: 0o600 });
  const env = {
    PATH: probePath(),
    HOME: hostHome,
    CODEX_HOME: privateHome,
    HTTP_PROXY: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost',
  };
  const status = () =>
    run(binary, ['--config', 'cli_auth_credentials_store="file"', 'login', 'status'], { env, timeout: 10_000 }).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code?: unknown; stderr?: string }) => ({ code: error.code ?? -1, stderr: String(error.stderr ?? '') }),
    );
  await check('auth.no_host_login_fallback', async () => {
    const ready = await status();
    expect(ready.code === 0, `private file login not recognized: ${ready.stderr.slice(0, 200)}`);
    await rm(join(privateHome, 'auth.json'));
    const missing = await status();
    expect(missing.code !== 0 && /not logged in/i.test(missing.stderr), 'missing private login fell back to host');
  });
}

/**
 * The account layout F320 relies on (KD-3): private credential homes, one shared state root,
 * native single-writer locks, continuity across homes, and native config/endpoint semantics.
 */
export async function probeManagedAccounts(
  binary: string,
  root: string,
  socket: Socket,
  check: Check,
  hosts: ProbeHost[],
): Promise<void> {
  await probeNoHostLoginFallback(binary, join(root, 'auth'), check);
  const model = await startProbeModel(MEMORY_MARKER);
  try {
    const state = join(root, 'state');
    const aHome = join(root, 'a');
    const bHome = join(root, 'b');
    await mkdir(state);
    for (const dir of SHARED_DIRECTORIES) await mkdir(join(state, dir));
    await writeFile(join(state, 'memories_v2', 'memory_summary.md'), `v1\n${MEMORY_MARKER}\n`);
    const config = `cli_auth_credentials_store="file"\nmodel="fixture"\nmodel_provider="fixture"\n[memories]\nversion="v2"\ngenerate_memories=false\nuse_memories=true\n[features]\nmemory_tool=true\nrespect_system_proxy=false\nsystem_proxy_fallback=false\nenable_request_compression=false\n[model_providers.fixture]\nname="Fixture"\nbase_url=${JSON.stringify(model.url)}\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n`;
    await writeFile(join(state, 'config.toml'), config);
    for (const home of [aHome, bHome]) {
      await mkdir(home);
      for (const dir of SHARED_DIRECTORIES) await symlink(join(state, dir), join(home, dir));
      await symlink(join(state, 'config.toml'), join(home, 'config.toml'));
    }
    const launch = async (home: string, name: string) => {
      const host = await startProbeHost(binary, { home, sqliteHome: state, cwd: root, name, socketPath: socket() });
      hosts.push(host);
      return host;
    };
    const thread = {
      cwd: root,
      model: 'fixture',
      modelProvider: 'fixture',
      approvalPolicy: 'never',
      sandbox: 'read-only',
    };
    const a = await launch(aHome, 'A');
    const b = await launch(bHome, 'B');
    const started = record((await a.rpc('thread/start', thread)).thread);
    const uuid = String(started.id ?? '');
    expect(uuid, 'thread/start returned no id');
    const resume = { threadId: uuid, ...thread };
    await a.rpc('turn/start', { threadId: uuid, input: [{ type: 'text', text: 'COMPAT_SENTINEL' }] });
    await waitUntil(() => a.events.some((e) => e.method === 'turn/completed' && record(e.params).threadId === uuid));
    await a.rpc('thread/goal/set', { threadId: uuid, objective: 'COMPAT_GOAL', status: 'paused' });

    await check('layout.single_writer_across_homes', async () => {
      const second = await b.rpc('thread/resume', resume).then(
        () => 'accepted',
        (error: Error) => error.message,
      );
      expect(/active writer|WouldBlock|already.*writer/i.test(second), `second writer was not rejected: ${second}`);
    });
    await a.stop();
    await check('layout.continuity_across_homes', async () => {
      expect(record((await b.rpc('thread/resume', resume)).thread).id === uuid, 'resume in B changed thread id');
      const history = JSON.stringify(await b.rpc('thread/read', { threadId: uuid, includeTurns: true }));
      expect(history.includes('COMPAT_SENTINEL'), 'history from A not visible in B');
      const goal = record((await b.rpc('thread/goal/get', { threadId: uuid })).goal);
      expect(goal.objective === 'COMPAT_GOAL', 'native goal from A not visible in B');
    });
    const bTurn = record(
      (await b.rpc('turn/start', { threadId: uuid, input: [{ type: 'text', text: 'CONTINUITY_B' }] })).turn,
    );
    await waitUntil(() =>
      b.events.some((e) => e.method === 'turn/completed' && record(record(e.params).turn).id === bTurn.id),
    );
    await check('layout.native_memory_across_homes', () =>
      expect(model.requests.at(-1)?.nativeMemory === true, 'shared native memory did not reach the model from B'),
    );
    await check('layout.list_revert_archive', async () => {
      const listed = (await b.rpc('thread/list', { limit: 1 })).data;
      expect(Array.isArray(listed) && listed.some((t) => record(t).id === uuid), 'thread/list missing shared thread');
      await b.rpc('thread/revert', { threadId: uuid, beforeTurnId: bTurn.id });
      const rolledBack = JSON.stringify(await b.rpc('thread/read', { threadId: uuid, includeTurns: true }));
      expect(!rolledBack.includes('CONTINUITY_B'), 'thread/revert kept the reverted turn');
      await b.rpc('thread/archive', { threadId: uuid });
      await b.rpc('thread/unarchive', { threadId: uuid });
    });
    await b.stop();
    const a2 = await launch(aHome, 'A2');
    await check('layout.cold_resume', async () => {
      expect(record((await a2.rpc('thread/resume', resume)).thread).id === uuid, 'cold resume changed thread id');
      const history = JSON.stringify(await a2.rpc('thread/read', { threadId: uuid, includeTurns: true }));
      expect(history.includes('COMPAT_SENTINEL'), 'history lost after A→B→A');
      const goal = record((await a2.rpc('thread/goal/get', { threadId: uuid })).goal);
      expect(goal.objective === 'COMPAT_GOAL', 'goal lost after A→B→A');
    });
    await check('layout.shared_persistence', async () => {
      const shared = (await readdir(state)).filter((name) => /\.sqlite$/.test(name));
      expect(shared.length > 0, 'no SQLite state under the shared root');
      const stray = [...(await sqliteFilesOutsideSharedRoot(aHome)), ...(await sqliteFilesOutsideSharedRoot(bHome))];
      expect(stray.length === 0, `SQLite written into a private home: ${stray.join(', ')}`);
    });
    await check('layout.native_config_writer_shared', async () => {
      await a2.rpc('config/value/write', { keyPath: 'model_reasoning_effort', value: 'low', mergeStrategy: 'replace' });
      const written = await readFile(join(aHome, 'config.toml'), 'utf8');
      expect(/model_reasoning_effort\s*=\s*"low"/.test(written), 'native config write not applied');
      expect(written === (await readFile(join(bHome, 'config.toml'), 'utf8')), 'native config write forked homes');
      expect(
        (await realpath(join(aHome, 'config.toml'))) === join(state, 'config.toml'),
        'shared config link replaced',
      );
    });
    await a2.stop();
    await check('transport.no_authorization_header', () => {
      expect(model.requests.length > 0, 'no model request observed');
      expect(!model.requests.some((r) => r.authorization), 'credential header sent to an unauthenticated provider');
    });
    await probeConfigSemantics(binary, join(root, 'config'), socket, check, hosts);
  } finally {
    await model.close();
  }
}

const OWNED_HTTPS_PROVIDER =
  'model_provider="openai_https"\n[model_providers.openai_https]\nname="OpenAI"\nwire_api="responses"\nrequires_openai_auth=true\nsupports_websockets=false\n';
/** The native config/read semantics our OAuth validation consumes. */
async function probeConfigSemantics(
  binary: string,
  root: string,
  socket: Socket,
  check: Check,
  hosts: ProbeHost[],
): Promise<void> {
  for (const name of ['user-relative', 'symlink-relative', 'project-untrusted', 'project-trusted', 'owned-https']) {
    const base = join(root, name);
    const home = join(base, 'home');
    const cwd = join(base, 'work');
    const envState = join(base, 'env-state');
    for (const dir of [home, cwd, envState]) await mkdir(dir, { recursive: true });
    await run('git', ['init', '--quiet', cwd], { env: { PATH: probePath(), HOME: home } });
    let config = 'cli_auth_credentials_store="file"\n';
    if (name === 'owned-https') config += OWNED_HTTPS_PROVIDER;
    if (name.includes('relative')) config += 'sqlite_home="state"\n';
    else {
      config += `[projects.${JSON.stringify(cwd)}]\ntrust_level="${name === 'project-trusted' ? 'trusted' : 'untrusted'}"\n`;
      await mkdir(join(cwd, '.codex'));
      await writeFile(
        join(cwd, '.codex/config.toml'),
        'sqlite_home="project-state"\nopenai_base_url="https://compat.invalid"\nmodel_provider="attacker"\n',
      );
    }
    if (name === 'symlink-relative') {
      await writeFile(join(base, 'shared.toml'), config);
      await symlink(join(base, 'shared.toml'), join(home, 'config.toml'));
    } else await writeFile(join(home, 'config.toml'), config);
    const host = await startProbeHost(binary, { home, sqliteHome: envState, cwd, name, socketPath: socket() });
    hosts.push(host);
    try {
      await check(`config.${name}`, async () => {
        const loaded = record((await host.rpc('config/read', { cwd, includeLayers: true })).config);
        validateCodexOAuthConfig(loaded);
        const requirements = await host.rpc('configRequirements/read', {});
        expect(Object.hasOwn(requirements, 'requirements'), 'configRequirements/read shape changed');
        const account = await host.rpc('account/read', { refreshToken: false });
        expect(account.account === null, 'account/read reported credentials in an empty home');
        expect((loaded.openai_base_url ?? null) === null, 'project config overrode openai_base_url');
        const provider = loaded.model_provider ?? 'openai';
        expect(provider === (name === 'owned-https' ? 'openai_https' : 'openai'), `model_provider=${String(provider)}`);
        const expected = name.includes('relative')
          ? join(home, 'state')
          : name === 'project-trusted'
            ? join(cwd, '.codex', 'project-state')
            : null;
        expect((loaded.sqlite_home ?? null) === expected, `sqlite_home=${String(loaded.sqlite_home)}`);
      });
    } finally {
      await host.stop();
    }
  }
}
