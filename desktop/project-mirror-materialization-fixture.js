const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROJECT_MIRROR_PROBES } = require('./project-mirrors');

const taskRoot = process.env.CLOWDER_MIRROR_TEST_ROOT || path.join(os.tmpdir(), 'clowder-mirror-materialization-tests');

function fixture(t) {
  fs.mkdirSync(taskRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(taskRoot, 'materialization-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installRoot = path.join(root, 'installed');
  const projectDir = path.join(root, 'data/project');
  for (const { mirror, relativePath } of PROJECT_MIRROR_PROBES) {
    const file = path.join(installRoot, mirror, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `bundled ${relativePath}\n`);
  }
  for (const mirror of ['docs', 'cat-cafe-skills']) {
    fs.writeFileSync(path.join(installRoot, mirror, 'complete-resource.txt'), 'not only startup probes\n');
  }
  const preserved = path.join(projectDir, '.cat-cafe/cat-catalog.json');
  fs.mkdirSync(path.dirname(preserved), { recursive: true });
  fs.writeFileSync(preserved, 'protected roles and bindings\n');
  const logs = [];
  return {
    root,
    installRoot,
    projectDir,
    preserved,
    logs,
    nodeExe: process.execPath,
    timeoutMs: 1500,
    // These tests exercise the retained read-failure recovery path separately
    // from Windows' proactive preparation, covered by the physical-root suite.
    platform: 'linux',
    log: (s) => logs.push(s),
  };
}

function rejectJunctionTraversal(t, value) {
  const roots = ['docs', 'cat-cafe-skills'].map((mirror) => path.join(value.projectDir, mirror));
  const preload = path.join(value.root, 'reject-managed-junction.cjs');
  const script = `const fs = require('node:fs');
const original = fs.readFileSync;
const roots = ${JSON.stringify(roots)};
fs.readFileSync = function(file, ...args) {
  if (typeof file === 'string' && roots.some(root => file.startsWith(root + require('node:path').sep) && fs.lstatSync(root).isSymbolicLink())) {
    throw Object.assign(new Error('injected junction traversal failure'), { code: 'UNKNOWN', errno: -4094, syscall: 'open' });
  }
  return original.call(this, file, ...args);
};`;
  fs.writeFileSync(preload, script);
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (
      typeof file === 'string' &&
      roots.some((root) => file.startsWith(root + path.sep) && fs.lstatSync(root).isSymbolicLink())
    ) {
      throw Object.assign(new Error('injected parent junction traversal failure'), {
        code: 'UNKNOWN',
        errno: -4094,
        syscall: 'open',
      });
    }
    return original.call(this, file, ...args);
  });
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previous ?? ''} --require ${JSON.stringify(preload)}`.trim();
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  });
}

function appendWorkerFault(value, script) {
  fs.appendFileSync(path.join(value.root, 'reject-managed-junction.cjs'), `\n${script}\n`);
}

function debris(value) {
  return fs.readdirSync(value.projectDir).filter((name) => name.startsWith('.clowder-resource-'));
}

module.exports = { fixture, rejectJunctionTraversal, appendWorkerFault, debris };
