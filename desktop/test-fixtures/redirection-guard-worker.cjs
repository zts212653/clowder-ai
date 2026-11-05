const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.argv[3] || process.env.CLOWDER_REDIRECTION_FIXTURE_ROOT;
assert.ok(root && path.basename(root).startsWith('redirection-guard-'));
const moduleRoot = process.env.CLOWDER_REDIRECTION_MODULE_ROOT || path.resolve(__dirname, '..');
const { prepareProjectMirrors, PROJECT_MIRROR_PROBES } = require(path.join(moduleRoot, 'project-mirrors'));
const { waitForProjectMirrors } = require(path.join(moduleRoot, 'project-mirror-readiness'));
const { readProjectMirrorsInConsumer } = require(path.join(moduleRoot, 'project-mirror-consumer'));
const installRoot = path.join(root, 'installed bundle');
const projectDir = path.join(root, 'user project');
const receipt = path.join(root, 'receipt.json');
const repoRoot = path.resolve(__dirname, '../..');

async function main() {
  if (process.argv[2] === 'create') {
    for (const { mirror, relativePath } of PROJECT_MIRROR_PROBES) {
      const file = path.join(installRoot, mirror, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, mirror, relativePath), file);
    }
    for (const relative of ['docs/extra.md', 'assets/prompt-templates/template.md', 'guides/catalog.yaml']) {
      fs.mkdirSync(path.dirname(path.join(installRoot, relative)), { recursive: true });
      fs.writeFileSync(path.join(installRoot, relative), relative);
    }
    fs.copyFileSync(
      path.join(repoRoot, 'assets/prompt-templates/a2a-ball-check.md'),
      path.join(installRoot, 'assets/prompt-templates/a2a-ball-check.md'),
    );
    fs.mkdirSync(projectDir);
    for (const mirror of ['docs', 'cat-cafe-skills', 'assets', 'guides']) {
      fs.symlinkSync(path.join(installRoot, mirror), path.join(projectDir, mirror), 'junction');
    }
    fs.writeFileSync(receipt, JSON.stringify({ phase: 'restricted-junctions-created', pid: process.pid }));
    return;
  }
  const blocked = PROJECT_MIRROR_PROBES.map(({ mirror, relativePath }) => path.join(projectDir, mirror, relativePath));
  for (const file of blocked) assert.throws(() => fs.readFileSync(file), { code: 'UNKNOWN' });
  const entries = PROJECT_MIRROR_PROBES.flatMap(({ mirror, relativePath }) =>
    ['source', 'mirror'].map((kind) => ({
      kind,
      mirror,
      path: path.join(kind === 'source' ? installRoot : projectDir, mirror, relativePath),
    })),
  );
  const before = await readProjectMirrorsInConsumer({ nodeExe: process.execPath, entries, timeoutMs: 5000 });
  assert.equal(before.length, 3, 'all three mirrors fail in a real inherited-policy consumer');
  assert.ok(before.every(({ kind, code }) => kind === 'mirror' && code === 'UNKNOWN'));
  const protectedFile = path.join(projectDir, '.cat-cafe', 'history.json');
  fs.mkdirSync(path.dirname(protectedFile));
  fs.writeFileSync(protectedFile, 'protected history and configuration');
  prepareProjectMirrors({ installRoot, projectDir });
  for (const mirror of ['docs', 'cat-cafe-skills', 'assets', 'guides']) {
    assert.equal(fs.lstatSync(path.join(projectDir, mirror)).isSymbolicLink(), false);
  }
  const ready = await waitForProjectMirrors({ installRoot, projectDir, nodeExe: process.execPath });
  const after = await readProjectMirrorsInConsumer({ nodeExe: process.execPath, entries, timeoutMs: 5000 });
  assert.deepEqual(after, []);
  const downstream = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const fs = require('node:fs');
    for (const file of ['docs/extra.md', 'assets/prompt-templates/template.md', 'guides/catalog.yaml'])
      if (!fs.readFileSync(file).length) process.exit(2);
  `,
    ],
    { cwd: projectDir, windowsHide: true, encoding: 'utf8' },
  );
  assert.equal(downstream.status, 0, downstream.stderr);
  const apiConsumers = await require('./physical-api-consumers.cjs')({ repoRoot, projectDir, root });
  prepareProjectMirrors({ installRoot, projectDir }); // Persistent reuse, no environment opt-in.
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'protected history and configuration');
  fs.writeFileSync(
    receipt,
    JSON.stringify(
      {
        phase: 'guarded-readiness-passed',
        pid: process.pid,
        nodeExe: process.execPath,
        before,
        after,
        ready,
        downstreamExit: downstream.status,
        apiConsumers,
        historyPreserved: true,
        systemPolicyChanged: false,
        aclChanged: false,
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  fs.writeFileSync(path.join(root, 'worker-error.txt'), error.stack);
  console.error(error);
  process.exitCode = 1;
});
