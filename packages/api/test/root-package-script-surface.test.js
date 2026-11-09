import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function extractDirectScriptRef(command) {
  const match = command.match(/^\s*((?:\.\/)?scripts\/[^\s'"]+)/);
  return match ? match[1].replace(/^\.\//, '') : null;
}

function missingScriptRefs(scripts, root) {
  const missing = [];
  for (const [scriptName, command] of Object.entries(scripts)) {
    for (const ref of extractScriptRefs(String(command))) {
      if (!globSync(ref, { cwd: root }).some((match) => statSync(path.join(root, match)).isFile())) {
        missing.push(`${scriptName} -> ${ref}`);
      }
    }
  }
  return missing;
}

test('root package scripts do not reference missing script files', () => {
  const missing = missingScriptRefs(readRootScripts(), repoRoot);
  assert.deepEqual(missing, [], `Missing script targets:\n${missing.join('\n')}`);
});

test('script target validation expands shell globs and rejects unmatched globs and missing literals', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'root-script-targets-'));
  try {
    mkdirSync(path.join(root, 'scripts'));
    writeFileSync(path.join(root, 'scripts/pre-push-fixture.test.mjs'), '');
    assert.deepEqual(missingScriptRefs({ hooks: 'node --test scripts/pre-push-*.test.mjs' }, root), []);
    assert.deepEqual(missingScriptRefs({ hooks: 'node --test scripts/missing-*.test.mjs scripts/missing.mjs' }, root), [
      'hooks -> scripts/missing-*.test.mjs',
      'hooks -> scripts/missing.mjs',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('alpha worktree manager exposes help output', () => {
  const alphaHelp = execFileSync('bash', ['./scripts/alpha-worktree.sh', '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.match(alphaHelp, /Clowder AI Alpha Worktree Manager/);
});

test('directly invoked root scripts keep executable bit', () => {
  if (process.platform === 'win32') return;

  const scripts = readRootScripts();
  const nonExecutable = [];

  for (const [scriptName, command] of Object.entries(scripts)) {
    const ref = extractDirectScriptRef(String(command));
    if (!ref) continue;

    const scriptPath = path.join(repoRoot, ref);
    if ((statSync(scriptPath).mode & 0o111) === 0) {
      nonExecutable.push(`${scriptName} -> ${ref}`);
    }
  }

  assert.deepEqual(nonExecutable, [], `Scripts missing executable bit:\n${nonExecutable.join('\n')}`);
});
