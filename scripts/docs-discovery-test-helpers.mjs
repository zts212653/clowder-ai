import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function writeFixture(root, relativePath, content = '# Fixture\n\nBody\n') {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

export function rel(root, paths) {
  return paths.map((entry) => path.relative(root, entry.path).split(path.sep).join('/')).sort();
}

export function makeRepo() {
  return mkdtempSync(path.join(tmpdir(), 'f243-docs-discovery-'));
}

export function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export function initGitRepo(root) {
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'F243 Test');
  git(root, 'config', 'user.email', 'f243-test@example.com');
}
