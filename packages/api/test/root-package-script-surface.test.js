import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
function readRootScripts() {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return packageJson.scripts ?? {};
}

function extractScriptRefs(command) {
  const refs = new Set();
  const matches = command.matchAll(
    /(?:^|\s)(?:bash|node)\s+((?:\.\/)?scripts\/[^\s'"]+)|(?:^|\s)((?:\.\/)?scripts\/[^\s'"]+)/g,
  );
  for (const match of matches) {
    const ref = match[1] ?? match[2];
    if (ref) refs.add(ref.replace(/^\.\//, ''));
  }
  return [...refs];
}

test('root package scripts do not reference missing script files', () => {
  const scripts = readRootScripts();
  const missing = [];

  for (const [scriptName, command] of Object.entries(scripts)) {
    for (const ref of extractScriptRefs(String(command))) {
      const scriptPath = path.join(repoRoot, ref);
      if (!existsSync(scriptPath)) {
        missing.push(`${scriptName} -> ${ref}`);
      }
    }
  }

  assert.deepEqual(missing, [], `Missing script targets:\n${missing.join('\n')}`);
});

test('alpha worktree scripts expose help output', () => {
  const alphaHelp = execFileSync('bash', ['./scripts/alpha-worktree.sh', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.match(alphaHelp, /Cat Cafe Alpha Worktree Manager/);

  const alphaTestHelp = execFileSync('bash', ['./scripts/alpha-worktree.test.sh', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.match(alphaTestHelp, /Smoke-check a running alpha environment/);
});
