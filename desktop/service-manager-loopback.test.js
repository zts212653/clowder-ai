// #1452 / #1459: exercise every desktop Next entry, including the Windows shim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function loadManager(platform, files) {
  const localRequire = createRequire(__filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'service-manager.js'), 'utf8'), {
    module,
    exports: module.exports,
    process: { platform, arch: 'x64', env: {}, stdout: { write() {} } },
    require(name) {
      if (name === 'node:fs') {
        return {
          existsSync: (file) => files.has(file),
          readdirSync: () => ['next@14.2.35'],
          mkdirSync() {},
          appendFileSync() {},
        };
      }
      if (name === 'node:child_process')
        return {
          execSync: () => '',
          spawn() {
            throw new Error('unexpected spawn');
          },
        };
      return localRequire(name);
    },
  });
  return module.exports;
}

const root = path.resolve('test-installed-root');
const web = path.join(root, 'packages', 'web');
const entries = {
  deployed: path.join(web, 'node_modules', 'next', 'dist', 'bin', 'next'),
  pnpm: path.join(root, 'node_modules', '.pnpm', 'next@14.2.35', 'node_modules', 'next', 'dist', 'bin', 'next'),
  hoisted: path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'),
  shim: path.join(web, 'node_modules', '.bin', 'next.cmd'),
};

for (const platform of ['darwin', 'linux', 'win32']) {
  for (const layout of ['deployed', 'pnpm', 'hoisted', ...(platform === 'win32' ? ['shim', 'path-shim'] : [])]) {
    test(`${platform} ${layout}: Next binds only IPv4 loopback`, () => {
      const files = new Set([entries[layout]]);
      if (layout === 'pnpm') files.add(path.join(root, 'node_modules', '.pnpm'));
      const Manager = loadManager(platform, files);
      const manager = new Manager(root, { frontendPort: 43173, apiPort: 43174 });
      let captured;
      manager._startProcess = (name, cmd, args, options) => {
        captured = { name, cmd, args, options };
      };
      manager._startNextJs();
      assert.equal(captured.name, 'web');
      assert.equal(captured.options.cwd, web);
      const args = Array.from(captured.args);
      assert.deepEqual(args.slice(args.indexOf('start')), ['start', '--port', '43173', '--hostname', '127.0.0.1']);
      assert.equal(args.filter((arg) => arg === '--hostname').length, 1);
      assert.equal(args.includes('0.0.0.0'), false);
      if (layout === 'shim') assert.equal(args[1], entries.shim);
      if (layout === 'path-shim') assert.equal(args[1], 'next.cmd');
    });
  }
}

test('missing POSIX Next entry fails without opening a listener', () => {
  const Manager = loadManager('darwin', new Set());
  const manager = new Manager(root, { frontendPort: 43173, apiPort: 43174 });
  let args;
  manager._startProcess = (_name, _cmd, value) => {
    args = Array.from(value);
  };
  manager._startNextJs();
  assert.equal(args[0], '-e');
  assert.match(args[1], /reinstall required/);
  assert.equal(args.includes('start'), false);
});
