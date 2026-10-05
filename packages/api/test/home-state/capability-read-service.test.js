import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * F300 Task 2.1 — the F041 capability board has one pure read path.
 *
 * Claims under test (Design Gate §5.1 claim guards):
 *  - reading never writes: a project with no capability config is answered
 *    `absent` and no file or directory appears (fs spy + tree diff);
 *  - "missing" and "could not read" are different answers;
 *  - the Console route, the snapshot route and the MCP tool report the same
 *    revision and sourceRefs for the same source state (AC-O2 parity);
 *  - member scope, source version and freshness are each returned.
 */

const WRITE_METHODS_ASYNC = [
  'writeFile',
  'appendFile',
  'mkdir',
  'rename',
  'rm',
  'rmdir',
  'unlink',
  'copyFile',
  'symlink',
  'open',
  'cp',
];
const WRITE_METHODS_SYNC = [
  'writeFileSync',
  'appendFileSync',
  'mkdirSync',
  'renameSync',
  'rmSync',
  'unlinkSync',
  'copyFileSync',
  'symlinkSync',
  'openSync',
  'cpSync',
];

/** Records every write-capable fs call made while `fn` runs (named ESM imports included). */
async function recordFsWrites(fn) {
  const calls = [];
  const restores = [];
  const wrap = (target, name, label) => {
    const original = target[name];
    if (typeof original !== 'function') return;
    target[name] = function (...args) {
      // `open` with a read flag is a read; anything else could create or change a file.
      const flags = name.startsWith('open') ? String(args[1] ?? 'r') : 'w';
      if (flags !== 'r') calls.push(`${label}.${name}(${String(args[0])})`);
      return original.apply(this, args);
    };
    restores.push(() => {
      target[name] = original;
    });
  };
  for (const name of WRITE_METHODS_ASYNC) wrap(fsPromises, name, 'fs/promises');
  for (const name of WRITE_METHODS_SYNC) wrap(fs, name, 'fs');
  syncBuiltinESMExports();
  try {
    return { result: await fn(), calls };
  } finally {
    for (const restore of restores) restore();
    syncBuiltinESMExports();
  }
}

async function listTree(dir) {
  const entries = await fsPromises.readdir(dir, { recursive: true });
  return entries.sort();
}

async function makeProject(prefix) {
  return fsPromises.mkdtemp(join(tmpdir(), `f300-cap-read-${prefix}-`));
}

const CONFIG_WITH_SECRET = {
  version: 2,
  discoveryVersion: 1,
  capabilities: [
    {
      id: 'secret-mcp',
      type: 'mcp',
      enabled: true,
      globalEnabled: true,
      source: 'external',
      blockedCats: ['opus'],
      mcpServer: { command: 'node', args: ['server.js', '--api-key=inline'], env: { API_KEY: 'raw-secret' } },
    },
  ],
};

describe('F300 2.1 capability read service', () => {
  const INVOCATION = { invocationId: 'inv-f300-cap', callbackToken: 'token-f300-cap' };
  const RECORD = {
    invocationId: INVOCATION.invocationId,
    userId: 'default-user',
    catId: 'codex-astra',
    threadId: 'thread-f300-cap',
    state: 'active',
  };
  const callbackRegistry = {
    verify: async (invocationId, callbackToken) =>
      invocationId === INVOCATION.invocationId && callbackToken === INVOCATION.callbackToken
        ? { ok: true, record: RECORD }
        : { ok: false, reason: 'unknown_invocation' },
  };

  let Fastify;
  let readCapabilitySnapshot;
  let readCapabilitiesConfigState;
  let readCapabilitiesConfig;
  let writeCapabilitiesConfig;
  let capabilitiesRoutes;
  let capabilitySnapshotRoutes;
  let handleCapabilitiesSnapshot;
  let savedEnv;
  let savedFetch;
  const cleanup = [];

  before(async () => {
    Fastify = (await import('fastify')).default;
    ({ readCapabilitySnapshot } = await import('../../dist/domains/capabilities/capability-read-service.js'));
    ({ readCapabilitiesConfigState, readCapabilitiesConfig, writeCapabilitiesConfig } = await import(
      '../../dist/config/capabilities/capability-orchestrator.js'
    ));
    ({ capabilitiesRoutes } = await import('../../dist/routes/capabilities.js'));
    ({ capabilitySnapshotRoutes } = await import('../../dist/routes/capability-snapshot.js'));
    ({ handleCapabilitiesSnapshot } = await import('../../../mcp-server/dist/tools/home-state-tools.js'));
    const { catRegistry } = await import('@cat-cafe/shared');
    if (!catRegistry.tryGet('codex-astra')) {
      catRegistry.register('codex-astra', { id: 'codex-astra', name: 'Astra', clientId: 'openai' });
    }
    savedEnv = { ...process.env };
    savedFetch = globalThis.fetch;
  });

  after(async () => {
    process.env = savedEnv;
    globalThis.fetch = savedFetch;
    for (const dir of cleanup) await fsPromises.rm(dir, { recursive: true, force: true });
  });

  async function appWithBothEntries() {
    const app = Fastify();
    await app.register(capabilitiesRoutes);
    await app.register(capabilitySnapshotRoutes, { callbackRegistry });
    await app.ready();
    return app;
  }

  it('answers a project with no config as typed absent and writes nothing', async () => {
    const projectRoot = await makeProject('absent');
    const mainRoot = await makeProject('absent-main');
    cleanup.push(projectRoot, mainRoot);
    const before = await listTree(projectRoot);

    const { result, calls } = await recordFsWrites(async () =>
      readCapabilitySnapshot({
        projectRoot,
        mainRoot,
        isProjectView: true,
        config: await readCapabilitiesConfigState(projectRoot),
        scope: { kind: 'member', catId: 'opus' },
      }),
    );

    assert.equal(result.status, 'absent');
    assert.equal(result.reason, 'config_missing');
    assert.equal(result.envelope.revision, 'config_missing');
    assert.match(result.envelope.sourceRefs[0], /\.cat-cafe\/capabilities\.json#absent$/);
    assert.deepEqual(calls, [], `read path wrote: ${calls.join(', ')}`);
    assert.deepEqual(await listTree(projectRoot), before);
    assert.equal(fs.existsSync(join(projectRoot, '.cat-cafe')), false);
  });

  it('snapshot route reads absent without bootstrapping; the Console route still owns bootstrap', async () => {
    const projectRoot = await makeProject('route-absent');
    cleanup.push(projectRoot);
    const app = await appWithBothEntries();
    try {
      const { result: res, calls } = await recordFsWrites(() =>
        app.inject({ url: `/api/capabilities/snapshot?projectPath=${encodeURIComponent(projectRoot)}` }),
      );
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().status, 'absent');
      assert.deepEqual(calls, [], `snapshot route wrote: ${calls.join(', ')}`);
      assert.deepEqual(await listTree(projectRoot), []);

      // Positive control: the same spy does see the writer route's bootstrap, so
      // the empty list above is a measurement, not a blind spot.
      const { result: console, calls: writerCalls } = await recordFsWrites(() =>
        app.inject({
          url: `/api/capabilities?projectPath=${encodeURIComponent(projectRoot)}`,
          headers: { 'x-cat-cafe-user': 'test-user' },
        }),
      );
      assert.equal(console.statusCode, 200, console.body);
      assert.ok(fs.existsSync(join(projectRoot, '.cat-cafe', 'capabilities.json')), 'writer route bootstraps');
      assert.ok(
        writerCalls.some((call) => call.includes('capabilities.json')),
        `spy missed the bootstrap write: ${writerCalls.join(', ')}`,
      );
    } finally {
      await app.close();
    }
  });

  it('keeps "cannot read" apart from "missing" and leaves the unreadable file alone', async () => {
    const projectRoot = await makeProject('corrupt');
    cleanup.push(projectRoot);
    await fsPromises.mkdir(join(projectRoot, '.cat-cafe'));
    const configPath = join(projectRoot, '.cat-cafe', 'capabilities.json');
    await fsPromises.writeFile(configPath, '{ not json');

    const state = await readCapabilitiesConfigState(projectRoot);
    assert.equal(state.kind, 'unreadable');
    assert.equal(await readCapabilitiesConfig(projectRoot), null, 'legacy reader keeps its contract');

    const { result, calls } = await recordFsWrites(() =>
      readCapabilitySnapshot({
        projectRoot,
        mainRoot: projectRoot,
        isProjectView: false,
        config: state,
        scope: { kind: 'console' },
      }),
    );
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'config_unreadable');
    assert.equal(result.cause, 'parse_error');
    assert.equal(result.envelope.revision, 'config_unreadable');
    assert.match(result.envelope.sourceRefs[0], /#unreadable$/);
    assert.deepEqual(calls, []);
    assert.equal(await fsPromises.readFile(configPath, 'utf8'), '{ not json');
  });

  // Review R1 P1-1 (codex-astra): a parser message quotes the bytes it choked
  // on, and those bytes can be a secret. Only a typed cause may leave.
  it('never echoes config bytes from a parse failure, over HTTP or MCP', async () => {
    const projectRoot = await makeProject('leak');
    cleanup.push(projectRoot);
    await fsPromises.mkdir(join(projectRoot, '.cat-cafe'));
    await fsPromises.writeFile(
      join(projectRoot, '.cat-cafe', 'capabilities.json'),
      '{"version":2,"capabilities":[{"id":"x","type":"mcp","mcpServer":{"env":{"API_KEY":DUMMY_TEST_SECRET}}}]}',
    );
    const app = await appWithBothEntries();
    try {
      const http = await app.inject({
        url: `/api/capabilities/snapshot?projectPath=${encodeURIComponent(projectRoot)}`,
        remoteAddress: '203.0.113.8',
        headers: { 'x-invocation-id': INVOCATION.invocationId, 'x-callback-token': INVOCATION.callbackToken },
      });
      assert.equal(http.statusCode, 200, http.body);
      assert.equal(http.json().status, 'unknown');
      assert.equal(http.json().cause, 'parse_error');
      assert.ok(!http.body.includes('DUMMY'), `HTTP body leaked config bytes: ${http.body}`);

      delete process.env.CAT_CAFE_CREDENTIAL_FILE;
      delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
      process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:39003';
      process.env.CAT_CAFE_INVOCATION_ID = INVOCATION.invocationId;
      process.env.CAT_CAFE_CALLBACK_TOKEN = INVOCATION.callbackToken;
      globalThis.fetch = async (url, init) => {
        const target = new URL(url);
        const response = await app.inject({
          url: target.pathname + target.search,
          headers: init?.headers ?? {},
          remoteAddress: '203.0.113.8',
        });
        return { ok: response.statusCode === 200, status: response.statusCode, json: async () => response.json() };
      };
      const mcpText = (await handleCapabilitiesSnapshot({ projectPath: projectRoot })).content[0].text;
      assert.ok(!mcpText.includes('DUMMY'), `MCP result leaked config bytes: ${mcpText}`);
    } finally {
      await app.close();
    }
  });

  // Review R1 P1-2: an inherited policy whose owner cannot be read is unknown,
  // not the project's stale copy.
  it('answers unknown when an external project inherits from an unreadable home config', async () => {
    const projectRoot = await makeProject('inherit');
    const mainRoot = await makeProject('inherit-main');
    cleanup.push(projectRoot, mainRoot);
    const cap = {
      id: 'inherit-mcp',
      type: 'mcp',
      source: 'external',
      enabled: true,
      globalEnabled: true,
      mcpServer: { command: 'node' },
    };
    await writeCapabilitiesConfig(projectRoot, { version: 2, discoveryVersion: 1, capabilities: [cap] });
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      discoveryVersion: 1,
      capabilities: [{ ...cap, globalEnabled: false }],
    });
    const read = async () =>
      readCapabilitySnapshot({
        projectRoot,
        mainRoot,
        isProjectView: true,
        config: await readCapabilitiesConfigState(projectRoot),
        scope: { kind: 'member', catId: 'opus' },
      });

    const readable = await read();
    assert.equal(readable.board.items.find((i) => i.id === 'inherit-mcp').globalEnabled, false);

    await fsPromises.writeFile(join(mainRoot, '.cat-cafe', 'capabilities.json'), '{ broken');
    const broken = await read();
    assert.equal(broken.status, 'unknown');
    assert.equal(broken.reason, 'global_config_unreadable');
    assert.equal(broken.cause, 'parse_error');
    assert.equal(broken.board, undefined, 'no board is computed from a policy nobody could read');
  });

  // Review R1 P1-3: every field is computed from the config the caller loaded,
  // never from a second read of the same file.
  it('derives mount rules from the captured config, not a re-read of disk', async () => {
    const projectRoot = await makeProject('captured');
    cleanup.push(projectRoot);
    const skill = { id: 'captured-skill', type: 'skill', source: 'external', enabled: true, globalEnabled: true };
    const configA = {
      version: 2,
      capabilities: [skill],
      mountRules: [{ name: 'claude', enabled: true, path: '.mount-a' }],
    };
    await writeCapabilitiesConfig(projectRoot, configA);
    await fsPromises.mkdir(join(projectRoot, '.mount-a', skill.id), { recursive: true });
    await fsPromises.writeFile(
      join(projectRoot, '.mount-a', skill.id, 'SKILL.md'),
      '---\ndescription: captured\n---\n',
    );
    const captured = await readCapabilitiesConfigState(projectRoot);
    const read = () =>
      readCapabilitySnapshot({
        projectRoot,
        mainRoot: projectRoot,
        isProjectView: true,
        config: captured,
        scope: { kind: 'console' },
      });

    const a = await read();
    await writeCapabilitiesConfig(projectRoot, {
      ...configA,
      mountRules: [{ name: 'claude', enabled: true, path: '.mount-b' }],
    });
    const b = await read();
    assert.deepEqual(b.board.items, a.board.items);
    assert.equal(b.envelope.revision, a.envelope.revision);
  });

  // Review R1 P1-4 + sweep: a skill file, SKILL.md metadata or manifest that
  // exists but cannot be read is a gap in the answer, not an absent skill.
  it('reports an unreadable SKILL.md as a gap instead of a complete scan', async () => {
    const projectRoot = await makeProject('child-denied');
    cleanup.push(projectRoot);
    const skill = { id: 'denied-skill', type: 'skill', source: 'external', enabled: true, globalEnabled: true };
    await writeCapabilitiesConfig(projectRoot, { version: 2, capabilities: [skill] });
    const skillFile = join(projectRoot, '.claude', 'skills', skill.id, 'SKILL.md');
    await fsPromises.mkdir(dirname(skillFile), { recursive: true });
    await fsPromises.writeFile(skillFile, '---\ndescription: denied\n---\n');
    await fsPromises.chmod(skillFile, 0o000);
    try {
      const result = await readCapabilitySnapshot({
        projectRoot,
        mainRoot: projectRoot,
        isProjectView: true,
        config: await readCapabilitiesConfigState(projectRoot),
        scope: { kind: 'console' },
      });
      assert.equal(result.board.skillHealth.scanComplete, false);
      assert.ok(
        result.board.skillHealth.unreadable.some((gap) => gap.endsWith(skillFile)),
        JSON.stringify(result.board.skillHealth.unreadable),
      );
    } finally {
      await fsPromises.chmod(skillFile, 0o644);
    }
  });

  it('distinguishes unreadable metadata from absent metadata', async () => {
    const { readSkillMetaState, parseManifestSkillMetaState } = await import('../../dist/skills/skill-meta.js');
    const dir = await makeProject('meta');
    cleanup.push(dir);
    assert.deepEqual(await readSkillMetaState(join(dir, 'nope')), { kind: 'absent' });
    assert.deepEqual(await parseManifestSkillMetaState(dir), { kind: 'absent' });

    await fsPromises.mkdir(join(dir, 'broken'));
    await fsPromises.writeFile(join(dir, 'broken', 'SKILL.md'), '---\ndescription: [unclosed\n---\n');
    assert.equal((await readSkillMetaState(join(dir, 'broken'))).kind, 'unreadable');

    await fsPromises.writeFile(join(dir, 'manifest.yaml'), 'skills: {}\n');
    await fsPromises.chmod(join(dir, 'manifest.yaml'), 0o000);
    try {
      assert.equal((await parseManifestSkillMetaState(dir)).kind, 'unreadable');
    } finally {
      await fsPromises.chmod(join(dir, 'manifest.yaml'), 0o644);
    }
  });

  // Review R2 P1-1: `cats` on a skill is where filesystem presence shows up;
  // dropping it from the hash made a real unmount invisible to the revision.
  it('moves the revision when a skill is unmounted even though config bytes are unchanged', async () => {
    const projectRoot = await makeProject('presence');
    cleanup.push(projectRoot);
    const id = 'presence-plugin-skill';
    const pluginSource = join(projectRoot, 'plugin-source');
    await fsPromises.mkdir(join(pluginSource, id), { recursive: true });
    await fsPromises.writeFile(join(pluginSource, id, 'SKILL.md'), '---\ndescription: presence\n---\n');
    const link = join(projectRoot, '.claude', 'skills', id);
    await fsPromises.mkdir(dirname(link), { recursive: true });
    await fsPromises.symlink(join(pluginSource, id), link);
    await writeCapabilitiesConfig(projectRoot, {
      version: 2,
      capabilities: [
        {
          id,
          type: 'skill',
          source: 'external',
          pluginId: 'presence-plugin',
          enabled: true,
          globalEnabled: true,
          skillsSource: pluginSource,
        },
      ],
    });
    const read = async (isProjectView) =>
      readCapabilitySnapshot({
        projectRoot,
        mainRoot: projectRoot,
        isProjectView,
        config: await readCapabilitiesConfigState(projectRoot),
        scope: { kind: 'console' },
      });

    const mounted = await read(true);
    assert.equal((await read(false)).envelope.revision, mounted.envelope.revision, 'views still share a revision');
    await fsPromises.unlink(link);
    const unmounted = await read(true);
    assert.notDeepEqual(unmounted.board.items[0].cats, mounted.board.items[0].cats, 'fixture must change presence');
    assert.notEqual(unmounted.envelope.revision, mounted.envelope.revision);
  });

  // Review R2 P1-2: the function that reads the link reports what it could not
  // read; a separate lstat pre-probe only guessed.
  it('reports readlink / realpath failures on a mount as gaps, keeping real results distinct', async () => {
    const { inspectSkillMountAtPoint } = await import('../../dist/utils/skill-mount.js');
    const root = await makeProject('link-io');
    cleanup.push(root);
    const skillsSrc = join(root, 'src-skills');
    await fsPromises.mkdir(join(skillsSrc, 'linked'), { recursive: true });
    await fsPromises.writeFile(join(skillsSrc, 'linked', 'SKILL.md'), '---\ndescription: linked\n---\n');
    const mountDir = join(root, '.claude', 'skills');
    await fsPromises.mkdir(mountDir, { recursive: true });
    const link = join(mountDir, 'linked');
    await fsPromises.symlink(join(skillsSrc, 'linked'), link);
    await fsPromises.symlink(join(root, 'elsewhere'), join(mountDir, 'wrong'));

    assert.deepEqual(await inspectSkillMountAtPoint([mountDir], skillsSrc, 'linked'), { state: 'mounted' });
    assert.deepEqual(await inspectSkillMountAtPoint([mountDir], skillsSrc, 'absent'), { state: 'not_mounted' });
    assert.deepEqual(await inspectSkillMountAtPoint([mountDir], skillsSrc, 'wrong'), { state: 'not_mounted' });

    const withFailure = async (method, failingPath) => {
      const original = fsPromises[method];
      fsPromises[method] = async function (path, ...rest) {
        if (String(path) === failingPath) throw Object.assign(new Error('injected'), { code: 'EIO' });
        return original.call(this, path, ...rest);
      };
      syncBuiltinESMExports();
      try {
        return await inspectSkillMountAtPoint([mountDir], skillsSrc, 'linked');
      } finally {
        fsPromises[method] = original;
        syncBuiltinESMExports();
      }
    };
    const readlinkFailed = await withFailure('readlink', link);
    assert.equal(readlinkFailed.state, 'unknown');
    assert.ok(readlinkFailed.gaps.includes(`EIO:${link}`), JSON.stringify(readlinkFailed));
    const realpathFailed = await withFailure('realpath', join(skillsSrc, 'linked'));
    assert.equal(realpathFailed.state, 'unknown');
    assert.ok(
      realpathFailed.gaps.some((gap) => gap.startsWith('EIO:')),
      JSON.stringify(realpathFailed),
    );
  });

  // Review R2 P1-3: valid JSON with malformed entries is an unsupported shape,
  // on every exit — not an exception.
  it('types malformed entries as unsupported_shape on state, legacy reader and HTTP', async () => {
    const projectRoot = await makeProject('null-entry');
    cleanup.push(projectRoot);
    await fsPromises.mkdir(join(projectRoot, '.cat-cafe'));
    await fsPromises.writeFile(
      join(projectRoot, '.cat-cafe', 'capabilities.json'),
      '{"version":2,"capabilities":[null]}',
    );

    assert.deepEqual(
      {
        kind: (await readCapabilitiesConfigState(projectRoot)).kind,
        cause: (await readCapabilitiesConfigState(projectRoot)).cause,
      },
      { kind: 'unreadable', cause: 'unsupported_shape' },
    );
    assert.equal(await readCapabilitiesConfig(projectRoot), null);
    const app = await appWithBothEntries();
    try {
      const res = await app.inject({
        url: `/api/capabilities/snapshot?projectPath=${encodeURIComponent(projectRoot)}`,
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().status, 'unknown');
      assert.equal(res.json().cause, 'unsupported_shape');
    } finally {
      await app.close();
    }
  });

  // Review R1 P2: global vs project view is presentation of one source state.
  it('keeps the revision the same across global and project views', async () => {
    const projectRoot = await makeProject('views');
    cleanup.push(projectRoot);
    await writeCapabilitiesConfig(projectRoot, {
      ...CONFIG_WITH_SECRET,
      capabilities: [{ ...CONFIG_WITH_SECRET.capabilities[0], globalEnabled: false }],
    });
    const read = async (isProjectView) =>
      readCapabilitySnapshot({
        projectRoot,
        mainRoot: projectRoot,
        isProjectView,
        config: await readCapabilitiesConfigState(projectRoot),
        scope: { kind: 'console' },
      });
    const global = await read(false);
    const project = await read(true);
    assert.notDeepEqual(
      global.board.items.map((i) => i.enabled),
      project.board.items.map((i) => i.enabled),
      'fixture must actually differ in presentation',
    );
    assert.equal(project.envelope.revision, global.envelope.revision);
  });

  it('Console route, snapshot route and MCP tool report the same revision and sourceRefs', async () => {
    const projectRoot = await makeProject('parity');
    cleanup.push(projectRoot);
    await writeCapabilitiesConfig(projectRoot, CONFIG_WITH_SECRET);
    const app = await appWithBothEntries();
    const query = `projectPath=${encodeURIComponent(projectRoot)}`;
    try {
      // The Console GET may persist sync results first; parity is about the state after it.
      const consoleFirst = await app.inject({ url: `/api/capabilities?${query}`, headers: { 'x-cat-cafe-user': 'u' } });
      assert.equal(consoleFirst.statusCode, 200, consoleFirst.body);
      const configPath = join(projectRoot, '.cat-cafe', 'capabilities.json');
      const settledBytes = await fsPromises.readFile(configPath);

      const snapshot = await app.inject({ url: `/api/capabilities/snapshot?${query}&catId=opus` });
      assert.equal(snapshot.statusCode, 200, snapshot.body);

      // The test brings its whole credential environment: a credential file or
      // agent key inherited from the shell running the suite would otherwise win.
      delete process.env.CAT_CAFE_CREDENTIAL_FILE;
      delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
      process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:39003';
      process.env.CAT_CAFE_INVOCATION_ID = INVOCATION.invocationId;
      process.env.CAT_CAFE_CALLBACK_TOKEN = INVOCATION.callbackToken;
      globalThis.fetch = async (url, init) => {
        const target = new URL(url);
        const response = await app.inject({
          url: target.pathname + target.search,
          headers: init?.headers ?? {},
          remoteAddress: '203.0.113.8',
        });
        return { ok: response.statusCode === 200, status: response.statusCode, json: async () => response.json() };
      };
      const mcp = JSON.parse((await handleCapabilitiesSnapshot({ projectPath: projectRoot })).content[0].text);
      const consoleAgain = await app.inject({ url: `/api/capabilities?${query}`, headers: { 'x-cat-cafe-user': 'u' } });

      const consoleEnvelope = consoleFirst.json().envelope;
      const snapshotBody = snapshot.json();
      assert.equal(snapshotBody.status, 'present');
      assert.equal(mcp.status, 'present');
      for (const other of [snapshotBody.envelope, mcp.envelope, consoleAgain.json().envelope]) {
        assert.equal(other.revision, consoleEnvelope.revision);
        assert.deepEqual(other.sourceRefs, consoleEnvelope.sourceRefs);
      }
      assert.match(consoleEnvelope.revision, /^sha256:[0-9a-f]{64}$/);
      assert.deepEqual(await fsPromises.readFile(configPath), settledBytes, 'reads left the config untouched');

      // Scope is presentation: the MCP caller is bound by its credentials, not a query.
      assert.deepEqual(mcp.scope, { kind: 'member', catId: 'codex-astra' });
      assert.deepEqual(snapshotBody.scope, { kind: 'member', catId: 'opus' });
      assert.equal(consoleEnvelope.visibility, 'authorized_shared');
      assert.equal(mcp.envelope.visibility, 'member_private');
    } finally {
      await app.close();
    }
  });

  it('member scope shows only the member own state and never launch fields or secrets', async () => {
    const projectRoot = await makeProject('member');
    cleanup.push(projectRoot);
    await writeCapabilitiesConfig(projectRoot, CONFIG_WITH_SECRET);
    const result = await readCapabilitySnapshot({
      projectRoot,
      mainRoot: projectRoot,
      isProjectView: true,
      config: await readCapabilitiesConfigState(projectRoot),
      scope: { kind: 'member', catId: 'codex-astra' },
      // Ignored for member scope, on purpose.
      secrets: { launchFields: true, values: true },
    });
    assert.equal(result.status, 'present');
    const item = result.board.items.find((entry) => entry.id === 'secret-mcp');
    assert.deepEqual(Object.keys(item.cats), ['codex-astra']);
    assert.deepEqual(item.blockedCats, [], "another member's block is not part of this answer");
    assert.equal(item.mcpServer.command, undefined);
    assert.equal(item.mcpServer.env, undefined);
    assert.deepEqual(item.mcpServer.envKeys, ['API_KEY']);
    assert.equal(result.board.allCats, undefined);
    assert.equal(result.board.knownProjectPaths, undefined);
  });

  it('returns source version and freshness; revision tracks the source, not the presentation', async () => {
    const projectRoot = await makeProject('revision');
    cleanup.push(projectRoot);
    await writeCapabilitiesConfig(projectRoot, CONFIG_WITH_SECRET);
    const configPath = join(projectRoot, '.cat-cafe', 'capabilities.json');
    const read = async (extra) =>
      readCapabilitySnapshot({
        projectRoot,
        mainRoot: projectRoot,
        isProjectView: false,
        config: await readCapabilitiesConfigState(projectRoot),
        scope: { kind: 'console' },
        now: () => 42,
        ...extra,
      });

    const plain = await read({});
    const sha = createHash('sha256')
      .update(await fsPromises.readFile(configPath))
      .digest('hex');
    assert.ok(plain.envelope.sourceRefs[0].endsWith(`capabilities.json#sha256=${sha}`), plain.envelope.sourceRefs[0]);
    assert.equal(plain.envelope.ownerRef, 'F041');
    assert.equal(plain.envelope.freshness.observedAt, 42);
    assert.ok(plain.envelope.freshness.invalidators.some((inv) => inv.ref.endsWith('capabilities.json')));

    const withSecrets = await read({ secrets: { launchFields: true, values: true } });
    assert.equal(withSecrets.board.items.find((i) => i.id === 'secret-mcp').mcpServer.command, 'node');
    assert.equal(withSecrets.envelope.revision, plain.envelope.revision);

    let probed = 0;
    const withProbe = await read({
      resolvers: {
        probeMcp: async () => {
          probed += 1;
          return { connectionStatus: 'connected' };
        },
      },
    });
    assert.equal(probed, 1);
    assert.equal(withProbe.board.items.find((i) => i.id === 'secret-mcp').connectionStatus, 'connected');
    assert.equal(withProbe.envelope.revision, plain.envelope.revision, 'live probe is not the source revision');

    await writeCapabilitiesConfig(projectRoot, {
      ...CONFIG_WITH_SECRET,
      capabilities: [{ ...CONFIG_WITH_SECRET.capabilities[0], globalEnabled: false }],
    });
    const changed = await read({});
    assert.notEqual(changed.envelope.revision, plain.envelope.revision);
  });

  it('says the skill scan was partial when a skill directory cannot be listed', async () => {
    const projectRoot = await makeProject('partial-scan');
    cleanup.push(projectRoot);
    await writeCapabilitiesConfig(projectRoot, CONFIG_WITH_SECRET);
    const read = async () =>
      readCapabilitySnapshot({
        projectRoot,
        mainRoot: projectRoot,
        isProjectView: false,
        config: await readCapabilitiesConfigState(projectRoot),
        scope: { kind: 'console' },
      });

    const complete = await read();
    assert.equal(complete.board.skillHealth.scanComplete, true);

    const skillsDir = join(projectRoot, '.claude', 'skills');
    await fsPromises.mkdir(skillsDir, { recursive: true });
    await fsPromises.chmod(skillsDir, 0o000);
    try {
      const partial = await read();
      assert.equal(partial.status, 'present');
      assert.equal(partial.board.skillHealth.scanComplete, false, 'unlistable dir must not pass as empty');
      assert.notEqual(partial.envelope.revision, complete.envelope.revision);
    } finally {
      await fsPromises.chmod(skillsDir, 0o755);
    }
  });

  it('refuses a remote caller without credentials and ignores a forged catId with them', async () => {
    const app = await appWithBothEntries();
    try {
      const anonymous = await app.inject({ url: '/api/capabilities/snapshot', remoteAddress: '203.0.113.8' });
      assert.equal(anonymous.statusCode, 401);

      const projectRoot = await makeProject('forged');
      cleanup.push(projectRoot);
      const forged = await app.inject({
        url: `/api/capabilities/snapshot?projectPath=${encodeURIComponent(projectRoot)}&catId=opus`,
        remoteAddress: '203.0.113.8',
        headers: { 'x-invocation-id': INVOCATION.invocationId, 'x-callback-token': INVOCATION.callbackToken },
      });
      assert.equal(forged.statusCode, 200, forged.body);
      assert.deepEqual(forged.json().scope, { kind: 'member', catId: 'codex-astra' });
    } finally {
      await app.close();
    }
  });
});
