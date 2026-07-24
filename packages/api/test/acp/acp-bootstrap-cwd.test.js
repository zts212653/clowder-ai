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
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

const {
  isPathWithinRoot,
  resolveAcpBootstrapArgs,
  resolveAcpBootstrapCommand,
  resolveAcpBootstrapCwd,
  resolveAcpBootstrapRoot,
} = await import('../../dist/domains/cats/services/agents/providers/acp/acp-bootstrap-cwd.js');

describe('acp bootstrap cwd', () => {
  const createdDirs = new Set();
  // #1203: Tests MUST run under a throwaway bootstrap root, injected explicitly
  // into resolveAcpBootstrapCwd(). The production root
  // (/tmp/cat-cafe-acp-bootstrap-uid-*) is shared with every running Clowder AI
  // instance on this machine — deleting it (the previous afterEach did exactly
  // that) pulls the cwd out from under live pooled ACP processes and the next
  // prompt dies with ACP -32603 getcwd ENOENT.
  let testBootstrapRoot;
  // Explicit deletion allowlist: afterEach may only rmSync paths inside one of
  // these roots. Anything else — above all the uid-shared production bootstrap
  // root — throws instead of deleting.
  const cleanupAllowlist = new Set();

  const allowCleanup = (root) => cleanupAllowlist.add(resolve(root));

  const assertSafeCleanupDir = (dir) => {
    const resolved = resolve(dir);
    for (const root of cleanupAllowlist) {
      // Platform-aware containment (PR #1207 codex P2): a hard-coded `/` prefix
      // fails on Windows, where resolve() produces backslash paths.
      if (isPathWithinRoot(root, resolved, { relative, isAbsolute })) return;
    }
    throw new Error(`REFUSING to delete path outside test cleanup allowlist: ${dir}`);
  };

  const makeTmpDir = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    allowCleanup(dir);
    return dir;
  };

  // All resolveAcpBootstrapCwd() calls in this suite go through the injected
  // throwaway root — the production root is never created, listed, or deleted.
  const testBootstrapCwd = (projectRoot, profile) => resolveAcpBootstrapCwd(projectRoot, profile, testBootstrapRoot);

  before(() => {
    // Portable throwaway root — never a hard-coded '/tmp' (PR #1207 sweep):
    // os.tmpdir() exists on every platform, '/tmp' does not on Windows.
    testBootstrapRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-acp-bootstrap-test-'));
    allowCleanup(testBootstrapRoot);
  });

  after(() => {
    // Final teardown goes through the same safety guard as afterEach.
    assertSafeCleanupDir(testBootstrapRoot);
    rmSync(testBootstrapRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const dir of createdDirs) {
      assertSafeCleanupDir(dir);
      rmSync(dir, { recursive: true, force: true });
    }
    createdDirs.clear();
  });

  it('creates a deterministic bootstrap dir outside the project root', () => {
    const projectRoot = resolve('/tmp/cat-cafe-project');

    const first = testBootstrapCwd(projectRoot, 'gemini-default');
    const second = testBootstrapCwd(projectRoot, 'gemini-default');
    createdDirs.add(first);

    assert.equal(first, second, 'same project/profile should reuse the same bootstrap dir');
    assert.ok(
      isPathWithinRoot(testBootstrapRoot, first, { relative, isAbsolute }),
      `bootstrap dir should live under the injected test root ${testBootstrapRoot}, got ${first}`,
    );
    assert.ok(existsSync(first), 'bootstrap dir should be created eagerly');
    assert.ok(
      !isPathWithinRoot(projectRoot, first, { relative, isAbsolute }),
      'bootstrap dir must not resolve inside the project root',
    );
  });

  it('recreates the deterministic bootstrap dir when it was cleaned up between cold starts', () => {
    const projectRoot = resolve('/tmp/cat-cafe-project');

    const first = testBootstrapCwd(projectRoot, 'recreate-guard');
    rmSync(first, { recursive: true, force: true });
    const second = testBootstrapCwd(projectRoot, 'recreate-guard');
    createdDirs.add(second);

    assert.equal(first, second, 'bootstrap path should stay deterministic across cold starts');
    assert.ok(existsSync(second), 'bootstrap dir should be recreated on demand');
  });

  it('enforces owner-only permissions on the bootstrap cwd', () => {
    const projectRoot = resolve('/tmp/cat-cafe-project');
    const dir = testBootstrapCwd(projectRoot, 'mode-guard');
    createdDirs.add(dir);

    chmodSync(dir, 0o755);
    testBootstrapCwd(projectRoot, 'mode-guard');

    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });

  it('sanitizes provider profile so it cannot escape the bootstrap root', () => {
    const projectRoot = resolve('/tmp/cat-cafe-project');
    const bootstrapRoot = testBootstrapRoot;

    const escaped = testBootstrapCwd(projectRoot, '../rogue/profile');
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
    const target = makeTmpDir('gemini-acp-target-');
    const bootstrapPath = testBootstrapCwd(projectRoot, 'symlink-guard');
    createdDirs.add(target);
    rmSync(bootstrapPath, { recursive: true, force: true });
    symlinkSync(target, bootstrapPath);
    createdDirs.add(bootstrapPath);

    assert.throws(() => testBootstrapCwd(projectRoot, 'symlink-guard'), /must not be a symlink/);
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
    const projectRoot = makeTmpDir('acp-project-');
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
    const projectRoot = makeTmpDir('acp-project-');
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

  it('expands model templates in startupArgs before spawning ACP clients', () => {
    const projectRoot = makeTmpDir('acp-project-');
    createdDirs.add(projectRoot);

    assert.deepEqual(
      resolveAcpBootstrapArgs(projectRoot, ['--model', '${base_model}', 'acp'], {
        base_model: 'anthropic/claude-sonnet-4-6',
      }),
      ['--model', 'anthropic/claude-sonnet-4-6', 'acp'],
    );
  });

  it('scopes bootstrap root by current uid or equivalent user identity', () => {
    // Pure path computation — no directories are created on the production root.
    const root = resolveAcpBootstrapRoot();
    assert.ok(
      root.startsWith('/tmp/cat-cafe-acp-bootstrap-'),
      `bootstrap root should match /tmp/cat-cafe-acp-bootstrap-*, got ${root}`,
    );
    assert.notEqual(root, testBootstrapRoot, 'default root must not collapse into the test root');
  });

  it('cleanup allowlist refuses the uid-shared production bootstrap root (#1203 sentinel)', () => {
    // The production root is the sentinel for every running instance on this
    // machine. The afterEach guard must reject it — and any path outside the
    // registered test roots — instead of deleting it.
    const productionRoot = resolveAcpBootstrapRoot();
    assert.throws(() => assertSafeCleanupDir(productionRoot), /outside test cleanup allowlist/);
    assert.throws(() => assertSafeCleanupDir('/tmp'), /outside test cleanup allowlist/);
    assert.throws(() => assertSafeCleanupDir(resolve('/')), /outside test cleanup allowlist/);
    // Registered test roots (and their children) are allowed.
    assertSafeCleanupDir(testBootstrapRoot);
    assertSafeCleanupDir(join(testBootstrapRoot, 'some-child-dir'));
    // A sibling sharing the root's path prefix is NOT inside it (prefix trap).
    assert.throws(
      () => assertSafeCleanupDir(`${testBootstrapRoot}-evil`),
      /outside test cleanup allowlist/,
      'sibling directory sharing a path prefix must be rejected',
    );
  });

  it('guards AcpServiceFactory against wiring ACP clients back to repo cwd', () => {
    const indexSource = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf-8');
    const factorySource = readFileSync(
      new URL('../../src/domains/cats/services/agents/providers/acp/AcpServiceFactory.ts', import.meta.url),
      'utf-8',
    );
    assert.ok(
      indexSource.includes('createAcpServiceForConfig'),
      'REGRESSION: index.ts must keep generic ACP service construction delegated to AcpServiceFactory.',
    );
    assert.ok(
      factorySource.includes('resolveAcpBootstrapCwd'),
      'REGRESSION: AcpServiceFactory must compute an isolated ACP bootstrap cwd.',
    );
    assert.ok(
      factorySource.includes('cwd: resolveAcpBootstrapCwd(projectRoot, profileId)'),
      'REGRESSION: AcpClient spawn cwd must be re-resolved per cold start, not reused from registry init.',
    );
    assert.ok(
      factorySource.includes('resolveAcpBootstrapCommand(projectRoot, acpConfig.command)'),
      'REGRESSION: AcpServiceFactory must preserve repo-relative ACP command resolution when using bootstrap cwd.',
    );
    assert.ok(
      factorySource.includes('resolveAcpBootstrapArgs(projectRoot, acpConfig.startupArgs'),
      'REGRESSION: AcpServiceFactory must resolve path-like startupArgs against the project root.',
    );
  });

  it('REGRESSION: ACP registry sync detects config from the active project root', () => {
    const indexSource = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf-8');

    assert.ok(
      indexSource.includes('resolveActiveProjectRoot'),
      'REGRESSION: index.ts must be able to resolve the active runtime project root during registry sync.',
    );
    assert.ok(
      indexSource.includes('getAcpConfig(id, projectRoot)'),
      'REGRESSION: syncAgentRegistry must pass the active project root to getAcpConfig().',
    );
    assert.ok(
      !indexSource.includes('const acpConfig = getAcpConfig(id);'),
      'REGRESSION: syncAgentRegistry must not read ACP config from the default template root.',
    );
  });

  it('REGRESSION: ACP static envVars merge must be outside authType guard (R5 P2)', () => {
    // After extraction to acp-spawn-env.ts, the guard reads the extracted module.
    const source = readFileSync(
      new URL('../../src/domains/cats/services/agents/providers/acp/acp-spawn-env.ts', import.meta.url),
      'utf-8',
    );
    // The static envVars pass-through must NOT be gated on authType === 'api_key'.
    // OAuth and static-only accounts also have envVars that must reach the subprocess.
    // Pattern: the `account?.envVars` loop must appear AFTER the api_key block closes.
    const apiKeyBlockEnd = source.indexOf("account?.authType === 'api_key'");
    const staticEnvLoop = source.indexOf('account?.envVars');
    assert.ok(apiKeyBlockEnd > 0, 'acp-spawn-env.ts must contain api_key auth block');
    assert.ok(staticEnvLoop > 0, 'acp-spawn-env.ts must contain static envVars pass-through');
    assert.ok(
      staticEnvLoop > apiKeyBlockEnd,
      'REGRESSION: static envVars merge must be outside authType === api_key guard (F171 CLI-path parity)',
    );
  });

  it('REGRESSION: --pure is NOT auto-injected; generic ACP is not command-sniffed', () => {
    const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf-8');
    // F161 Phase C: --pure is no longer auto-injected for OpenCode members.
    // Internal opencode agents may not support --pure; the user provides it via
    // startup args (e.g. "acp --pure") if their agent needs it.
    // Generic ACP (clientId='acp') is never auto-managed by sniffing the command
    // basename — the operator configures startup args explicitly.
    assert.ok(
      !source.includes("!acpArgs.includes('--pure')"),
      'REGRESSION: index.ts must NOT auto-inject --pure (user-configurable via startup args)',
    );
    assert.ok(
      !source.includes('isOpenCodeCommand'),
      'REGRESSION: index.ts must NOT sniff command basename (isOpenCodeCommand) to auto-manage ACP',
    );
  });

  it('REGRESSION: generic ACP env mapping must not infer built-in clients from command', () => {
    const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf-8');
    assert.ok(
      !source.includes('resolveEnvMapClientId'),
      'REGRESSION: generic clientId=acp must use only user envVars templates, not command basename aliases',
    );
  });

  it('REGRESSION: AcpClient must filter MCP servers by client mcpCapabilities', () => {
    const source = readFileSync(
      new URL('../../src/domains/cats/services/agents/providers/acp/AcpClient.ts', import.meta.url),
      'utf-8',
    );
    // Sending stdio MCP servers to clients that only support http/sse (e.g. OpenCode)
    // causes session/new to hang. AcpClient.filterMcpByCapabilities() must exist and
    // be called in both newSession() and loadSession().
    assert.ok(
      source.includes('filterMcpByCapabilities'),
      'REGRESSION: AcpClient must implement filterMcpByCapabilities to prevent sending unsupported MCP transports',
    );
    // newSession uses it
    assert.ok(
      source.includes('filterMcpByCapabilities(mcpServers)'),
      'REGRESSION: newSession() and loadSession() must filter MCP servers before sending to client',
    );
    // The filter checks mcpCapabilities from initResult
    assert.ok(
      source.includes('initResult?.agentCapabilities?.mcpCapabilities'),
      'REGRESSION: filter must read mcpCapabilities from the ACP initialize result',
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
