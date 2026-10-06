import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { probeNode, smokeNativeModules } from './lib/build-node.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const sourceApi = path.resolve(process.env.CLOWDER_NATIVE_SMOKE_TEST_API || path.join(root, 'bundled/deploy/api'));
const available = fs.existsSync(path.join(sourceApi, 'node_modules'));
if (process.env.CLOWDER_REQUIRE_NATIVE_ARTIFACT_TESTS === '1')
  assert.ok(available, 'Deploy the API before native tests');
const requireSource = createRequire(path.join(sourceApi, 'package.json'));
const modules = ['better-sqlite3', 'sqlite-vec', 'node-pty', 'sharp'];
const guard = path.join(import.meta.dirname, 'lib/native-artifact-guard.cjs');

function windowsPathAudit(api, targets = new Map()) {
  const probe = {
    platform: 'win32',
    env: { CLOWDER_NATIVE_SMOKE_ROOT: api, SystemRoot: 'C:\\Windows' },
    report: { getReport: () => ({ sharedObjects: [] }) },
    dlopen() {},
  };
  const context = vm.createContext({
    process: probe,
    console: { log() {} },
    require(name) {
      if (name === 'node:fs') return { realpathSync: (file) => targets.get(file) || file };
      if (name === 'node:path') return path.win32;
      if (name === 'node:module') return { registerHooks() {} };
      if (name === 'node:url')
        return {
          fileURLToPath() {
            throw new Error('Not a URL probe');
          },
        };
      throw new Error(`Unexpected probe dependency: ${name}`);
    },
  });
  vm.runInContext(fs.readFileSync(guard, 'utf8'), context);
  return context.clowderNativeArtifactAudit;
}

test('Windows native containment accepts ordinary and namespaced drive/UNC spelling', () => {
  // Exercise the real guard with Windows path semantics. This is a path
  // contract test; the real Windows native suite below remains mandatory CI.
  for (const api of ['C:\\Artifact\\api', '\\\\server\\share\\Artifact\\api']) {
    const audit = windowsPathAudit(api);
    const native = path.win32.join(api, 'node_modules', 'pty', 'native.node');
    assert.equal(audit.artifactPath(path.win32.toNamespacedPath(native)), path.win32.toNamespacedPath(native));
    audit.assertComplete();
  }
});

test('Windows namespace normalization still rejects siblings, other drives and UNC shares', () => {
  const api = 'C:\\Artifact\\api';
  for (const external of [
    'C:\\Artifact\\api\\node_modules-elsewhere\\native.node',
    'D:\\Artifact\\api\\node_modules\\native.node',
    '\\\\server\\other-share\\Artifact\\api\\node_modules\\native.node',
  ]) {
    const audit = windowsPathAudit(api);
    assert.throws(() => audit.artifactPath(path.win32.toNamespacedPath(external)), /escapes deployed node_modules/);
    assert.throws(() => audit.assertComplete(), /escapes deployed node_modules/);
  }
});

test('Windows namespaced symlink targets remain subject to realpath containment', () => {
  const api = 'C:\\Artifact\\api';
  const alias = path.win32.toNamespacedPath(path.win32.join(api, 'node_modules', 'native.node'));
  const outside = path.win32.toNamespacedPath('C:\\Host\\native.node');
  const audit = windowsPathAudit(api, new Map([[alias, outside]]));
  assert.throws(() => audit.artifactPath(alias), /escapes deployed node_modules/);
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-artifact-'));
  // Deliberately give incomplete artifacts an ancestor with all real native
  // dependencies available: this is the false-green mechanism from R1 F1.
  fs.symlinkSync(path.resolve(sourceApi, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  const api = path.join(dir, 'artifact/api');
  fs.mkdirSync(path.join(api, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(api, 'package.json'), '{}');
  const copied = new Set();
  function copy(name, required) {
    if (copied.has(name)) return;
    const src = path.join(sourceApi, 'node_modules', name);
    if (!fs.existsSync(src)) {
      if (required) throw new Error(`Missing source dependency: ${name}`);
      return;
    }
    copied.add(name);
    const dest = path.join(api, 'node_modules', name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json')));
    for (const dependency of Object.keys(pkg.dependencies || {})) copy(dependency, true);
    for (const dependency of Object.keys(pkg.optionalDependencies || {})) copy(dependency, false);
  }
  for (const name of modules) copy(name, true);
  return { dir, api: fs.realpathSync(api) };
}

function withFixture(action) {
  const { dir, api } = fixture();
  try {
    action(api, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('real native closure and PTY child succeed with injected Node env removed', { skip: !available }, () => {
  withFixture((api, dir) => {
    const injection = path.join(dir, 'injection.cjs');
    fs.writeFileSync(injection, 'throw new Error("INJECTED_NODE_OPTIONS");');
    const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH };
    try {
      process.env.NODE_OPTIONS = `--require ${injection}`;
      process.env.NODE_PATH = path.join(dir, 'node_modules');
      assert.equal(probeNode(process.execPath).version, process.version);
      const output = smokeNativeModules(process.execPath, api);
      assert.match(output, /native-pty: spawned bundled Node, marker received, exited/);
      assert.match(output, /native-smoke: OK/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test(
  'local JS entries cannot borrow a missing sqlite-vec platform binary from an ancestor',
  { skip: !available },
  () => {
    withFixture((api) => {
      const vecPlatform = `sqlite-vec-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
      fs.rmSync(path.join(api, 'node_modules', vecPlatform), { recursive: true });
      const requireArtifact = createRequire(path.join(api, 'package.json'));
      for (const name of modules) assert.ok(requireArtifact.resolve(name).startsWith(api + path.sep));
      // Prove the dependency is borrowable, then assert that the real smoke fails.
      assert.ok(
        !requireArtifact('sqlite-vec')
          .getLoadablePath()
          .startsWith(api + path.sep),
      );
      assert.throws(() => smokeNativeModules(process.execPath, api), /escapes deployed node_modules/);
    });
  },
);

test('a missing transitive sharp dependency cannot resolve from the host', { skip: !available }, () => {
  withFixture((api) => {
    fs.rmSync(path.join(api, 'node_modules/detect-libc'), { recursive: true });
    assert.throws(() => smokeNativeModules(process.execPath, api), /escapes deployed node_modules/);
  });
});

test('the SQLite extension path and native dlopen symlinks cannot escape', { skip: !available }, () => {
  withFixture((api) => {
    const native = requireSource('sqlite-vec').getLoadablePath();
    const local = createRequire(path.join(api, 'package.json'))('sqlite-vec').getLoadablePath();
    fs.unlinkSync(local);
    fs.symlinkSync(native, local);
    assert.throws(() => smokeNativeModules(process.execPath, api), /escapes deployed node_modules/);
  });
});

test('guard preload constrains both ESM and inherited worker resolution', { skip: !available }, () => {
  withFixture((api, dir) => {
    const external = path.join(dir, 'external.mjs');
    fs.writeFileSync(external, 'export default 1;');
    const entry = path.join(api, 'node_modules/probe.cjs');
    fs.writeFileSync(
      entry,
      `import(${JSON.stringify(pathToFileURL(external).href)}).catch(e => {console.error(e); process.exitCode=1;});`,
    );
    const workerCode = `const {Worker}=require('node:worker_threads');new Worker(${JSON.stringify(entry)}).on('exit',code=>{process.exitCode=code;});`;
    for (const args of [[entry], ['-e', workerCode]]) {
      assert.throws(
        () =>
          execFileSync(process.execPath, ['--require', guard, ...args], {
            env: { CLOWDER_NATIVE_SMOKE_ROOT: api, SystemRoot: process.env.SystemRoot },
            encoding: 'utf8',
            timeout: 10000,
          }),
        /escapes deployed node_modules/,
      );
    }
  });
});

for (const state of ['missing', 'corrupt', 'wrong-architecture']) {
  test(
    `${process.platform} real PTY rejects ${state} native even with borrowable host modules`,
    {
      skip: !available,
    },
    () => {
      const natives = process.platform === 'win32' ? ['conpty.node', 'conpty_console_list.node'] : ['pty.node'];
      for (const native of natives) {
        withFixture((api) => {
          const pty = path.join(api, 'node_modules/node-pty');
          const files = fs.readdirSync(pty, { recursive: true }).filter((file) => path.basename(file) === native);
          assert.ok(files.length, `Native ${native} must exist in the good ${process.platform} deploy`);
          const foreign = path.join(
            pty,
            'prebuilds',
            `${process.platform}-${process.arch === 'arm64' ? 'x64' : 'arm64'}`,
            native,
          );
          const foreignBytes = state === 'wrong-architecture' ? fs.readFileSync(foreign) : null;
          for (const file of files) {
            const target = path.join(pty, file);
            if (state === 'missing') fs.unlinkSync(target);
            else fs.writeFileSync(target, foreignBytes || 'CORRUPT_NATIVE_BINARY');
          }
          assert.throws(
            () => smokeNativeModules(process.execPath, api),
            /Failed to load native module|DLOPEN|not a valid/,
          );
        });
      }
    },
  );
}
