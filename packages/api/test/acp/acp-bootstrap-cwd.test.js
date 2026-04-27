import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, win32 } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const {
  isPathWithinRoot,
  resolveAcpBootstrapArgs,
  resolveAcpBootstrapCommand,
  resolveAcpBootstrapCwd,
  resolveAcpBootstrapRoot,
} = await import('../../dist/domains/cats/services/agents/providers/acp/acp-bootstrap-cwd.js');

describe('acp bootstrap cwd', () => {
  const createdDirs = new Set();

  afterEach(() => {
    for (const dir of createdDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    createdDirs.clear();
  });

  it('creates a deterministic bootstrap dir outside the project root', () => {
    const projectRoot = resolve('/tmp/cat-cafe-project');
    const bootstrapRoot = resolveAcpBootstrapRoot();

    const first = resolveAcpBootstrapCwd(projectRoot, 'gemini-default');
    const second = resolveAcpBootstrapCwd(projectRoot, 'gemini-default');
    createdDirs.add(first);
    createdDirs.add(bootstrapRoot);

    assert.equal(first, second, 'same project/profile should reuse the same bootstrap dir');
    assert.ok(first.startsWith(tmpdir()), `bootstrap dir should live under tmpdir(), got ${first}`);
    assert.ok(existsSync(first), 'bootstrap dir should be created eagerly');
    assert.ok(
      !first.startsWith(`${projectRoot}/`) && first !== projectRoot,
      'bootstrap dir must not resolve inside the project root',
    );
  });

  it('recreates the deterministic bootstrap dir when it was cleaned up between cold starts', () => {
    const projectRoot = resolve('/tmp/cat-cafe-project');
    createdDirs.add(resolveAcpBootstrapRoot());

    const first = resolveAcpBootstrapCwd(projectRoot, 'recreate-guard');
    rmSync(first, { recursive: true, force: true });
    const second = resolveAcpBootstrapCwd(projectRoot, 'recreate-guard');
    createdDirs.add(second);

    assert.equal(first, second, 'bootstrap path should stay deterministic across cold starts');
    assert.ok(existsSync(second), 'bootstrap dir should be recreated on demand');
  });

  it('enforces owner-only permissions on the bootstrap cwd', () => {
    const projectRoot = resolve('/tmp/cat-cafe-project');
    const dir = resolveAcpBootstrapCwd(projectRoot, 'mode-guard');
    createdDirs.add(dir);
    createdDirs.add(resolveAcpBootstrapRoot());

    chmodSync(dir, 0o755);
    resolveAcpBootstrapCwd(projectRoot, 'mode-guard');

    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it('sanitizes provider profile so it cannot escape the bootstrap root', () => {
    const projectRoot = resolve('/tmp/cat-cafe-project');
    const bootstrapRoot = resolveAcpBootstrapRoot();

    const escaped = resolveAcpBootstrapCwd(projectRoot, '../rogue/profile');
    createdDirs.add(escaped);

    const relativeToBootstrapRoot = relative(bootstrapRoot, escaped);
    assert.ok(
      relativeToBootstrapRoot && !relativeToBootstrapRoot.startsWith('..'),
      `bootstrap dir must stay under ${bootstrapRoot}, got ${escaped}`,
    );
    assert.equal(
      relativeToBootstrapRoot.split(/[\\/]/).length,
      1,
      `providerProfile should be sanitized into a single path segment, got ${relativeToBootstrapRoot}`,
    );
  });

  it('rejects a pre-created symlink at the bootstrap cwd path', () => {
    const projectRoot = resolve('/tmp/cat-cafe-project');
    const bootstrapRoot = resolveAcpBootstrapRoot();
    const target = mkdtempSync(join(tmpdir(), 'gemini-acp-target-'));
    const bootstrapPath = resolveAcpBootstrapCwd(projectRoot, 'symlink-guard');
    createdDirs.add(target);
    rmSync(bootstrapPath, { recursive: true, force: true });
    symlinkSync(target, bootstrapPath);
    createdDirs.add(bootstrapPath);
    createdDirs.add(bootstrapRoot);

    assert.throws(() => resolveAcpBootstrapCwd(projectRoot, 'symlink-guard'), /must not be a symlink/);
  });

  it('uses platform-safe containment checks for Windows-style paths', () => {
    assert.equal(isPathWithinRoot('C:\\tmp\\cat-cafe-gemini-acp', 'C:\\tmp\\cat-cafe-gemini-acp\\child', win32), true);
    assert.equal(
      isPathWithinRoot('C:\\tmp\\cat-cafe-gemini-acp', 'C:\\tmp\\cat-cafe-gemini-acp-evil\\child', win32),
      false,
    );
    assert.equal(isPathWithinRoot('C:\\tmp\\cat-cafe-gemini-acp', 'D:\\tmp\\cat-cafe-gemini-acp\\child', win32), false);
  });

  it('resolves relative ACP commands against the project root', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-project-'));
    writeFileSync(join(projectRoot, 'agent.js'), 'console.log("ok");\n');
    writeFileSync(join(projectRoot, 'gemini'), 'echo hijack\n');
    createdDirs.add(projectRoot);

    assert.equal(resolveAcpBootstrapCommand(projectRoot, 'agent.js'), 'agent.js');
    assert.equal(resolveAcpBootstrapCommand(projectRoot, './agent.js'), resolve(projectRoot, './agent.js'));
    assert.equal(resolveAcpBootstrapCommand(projectRoot, 'gemini'), 'gemini');
    assert.equal(resolveAcpBootstrapCommand(projectRoot, 'gemini'), 'gemini');
    assert.equal(resolveAcpBootstrapCommand(projectRoot, '/opt/bin/gemini'), '/opt/bin/gemini');
  });

  it('resolves path-like startupArgs against the project root', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'acp-project-'));
    writeFileSync(join(projectRoot, 'settings.json'), '{}\n');
    writeFileSync(join(projectRoot, 'runner.js'), 'console.log("ok");\n');
    writeFileSync(join(projectRoot, 'yolo'), 'not-a-path\n');
    createdDirs.add(projectRoot);

    assert.deepEqual(resolveAcpBootstrapArgs(projectRoot, ['--acp', '--approval-mode', 'yolo']), [
      '--acp',
      '--approval-mode',
      'yolo',
    ]);
    assert.deepEqual(resolveAcpBootstrapArgs(projectRoot, ['runner.js', '--config=settings.json']), [
      resolve(projectRoot, 'runner.js'),
      `--config=${resolve(projectRoot, 'settings.json')}`,
    ]);
    assert.deepEqual(resolveAcpBootstrapArgs(projectRoot, ['./runner.js', '--config=./settings.json']), [
      resolve(projectRoot, './runner.js'),
      `--config=${resolve(projectRoot, './settings.json')}`,
    ]);
    assert.deepEqual(resolveAcpBootstrapArgs(projectRoot, ['yolo', '--approval-mode=yolo']), [
      'yolo',
      '--approval-mode=yolo',
    ]);
  });

  it('scopes bootstrap root by current uid or equivalent user identity', () => {
    const root = resolveAcpBootstrapRoot();
    assert.ok(root.startsWith(tmpdir()), `bootstrap root should stay under tmpdir(), got ${root}`);
    assert.ok(
      /cat-cafe-gemini-acp-(uid|user)-/.test(root),
      `bootstrap root should be namespaced per owner identity, got ${root}`,
    );
  });

  it('guards index.ts against wiring Gemini ACP back to repo cwd', () => {
    const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf-8');
    assert.ok(
      source.includes('resolveAcpBootstrapCwd'),
      'REGRESSION: index.ts must compute an isolated Gemini ACP bootstrap cwd.',
    );
    assert.ok(
      source.includes('cwd: resolveAcpBootstrapCwd(acpProjectRoot, id)'),
      'REGRESSION: AcpClient spawn cwd must be re-resolved per cold start, not reused from registry init.',
    );
    assert.ok(
      source.includes('resolveAcpBootstrapCommand'),
      'REGRESSION: index.ts must preserve repo-relative ACP command resolution when using bootstrap cwd.',
    );
    assert.ok(
      source.includes('resolveAcpBootstrapArgs'),
      'REGRESSION: index.ts must resolve path-like startupArgs against the project root.',
    );
  });

  it('guards helper against TOCTTOU existsSync + mkdirSync creation', () => {
    const source = readFileSync(
      new URL('../../src/domains/cats/services/agents/providers/acp/acp-bootstrap-cwd.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(
      !source.includes('existsSync(dir)'),
      'REGRESSION: bootstrap dir creation must not preflight with existsSync(dir).',
    );
    assert.ok(source.includes("code !== 'EEXIST'"), 'REGRESSION: bootstrap dir creation should tolerate EEXIST races.');
  });
});
