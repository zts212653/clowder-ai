import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { materializeAgyNativeMcpConfig } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-mcp-config.js'
);

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'f325-handoff-')));
  const oldRoot = join(base, 'alpha');
  const newRoot = join(base, 'runtime');
  mkdirSync(oldRoot);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  git(oldRoot, 'init', '-q');
  git(
    oldRoot,
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  );
  git(oldRoot, 'worktree', 'add', '--detach', newRoot, 'HEAD');
  for (const root of [oldRoot, newRoot]) {
    mkdirSync(join(root, 'packages/mcp-server/dist'), { recursive: true });
    writeFileSync(join(root, 'packages/mcp-server/dist/collab.js'), '// fixture');
  }
  const home = join(base, 'profile');
  const dir = join(home, '.gemini/config/cat-cafe-credentials');
  mkdirSync(dir, { recursive: true });
  const oldCredential = join(dir, '00000000-0000-4000-8000-000000000001.json');
  const credentialFile = join(dir, '00000000-0000-4000-8000-000000000002.json');
  writeFileSync(credentialFile, '{}', { mode: 0o600 });
  const configPath = join(home, '.gemini/config/mcp_config.json');
  const prior = {
    mcpServers: {
      'cat-cafe-collab': {
        command: realpathSync(process.execPath),
        args: [realpathSync(join(oldRoot, 'packages/mcp-server/dist/collab.js'))],
        env: { CAT_CAFE_API_URL: 'http://127.0.0.1:3012', CAT_CAFE_CREDENTIAL_FILE: oldCredential },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(prior));
  const run = () =>
    materializeAgyNativeMcpConfig({
      profileHome: home,
      runtimeRoot: newRoot,
      serverNames: ['cat-cafe-collab'],
      callback: { apiUrl: 'http://127.0.0.1:3004', credentialFile },
    });
  return {
    base,
    oldRoot,
    newRoot,
    oldCredential,
    configPath,
    prior,
    run,
    git,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

test('hands off a stale built-in Alpha binding to another worktree of the same repository', () => {
  const f = fixture();
  try {
    f.run();
    const server = JSON.parse(readFileSync(f.configPath, 'utf8')).mcpServers['cat-cafe-collab'];
    assert.equal(server.args[0], realpathSync(join(f.newRoot, 'packages/mcp-server/dist/collab.js')));
    assert.equal(server.env.CAT_CAFE_API_URL, 'http://127.0.0.1:3004');
    assert.ok(!JSON.stringify(server).includes(f.oldCredential));
  } finally {
    f.cleanup();
  }
});

for (const variant of [
  'active',
  'dangling credential',
  'foreign repository',
  'symlink entrypoint',
  'symlink directory',
  'wrapper',
  'remote URL',
  'writer lock',
]) {
  test(`refuses ${variant} and preserves the previous binding`, () => {
    const f = fixture();
    try {
      const server = f.prior.mcpServers['cat-cafe-collab'];
      if (variant === 'active') writeFileSync(f.oldCredential, '{}');
      if (variant === 'dangling credential') symlinkSync(join(f.base, 'absent'), f.oldCredential);
      if (variant === 'foreign repository') {
        const foreign = join(f.base, 'foreign');
        mkdirSync(foreign);
        f.git(foreign, 'init', '-q');
        mkdirSync(join(foreign, 'packages/mcp-server/dist'), { recursive: true });
        writeFileSync(join(foreign, 'packages/mcp-server/dist/collab.js'), '// foreign');
        server.args = [join(foreign, 'packages/mcp-server/dist/collab.js')];
      }
      if (variant === 'symlink entrypoint') {
        const path = server.args[0];
        rmSync(path);
        symlinkSync(join(f.newRoot, 'packages/mcp-server/dist/collab.js'), path);
      }
      if (variant === 'wrapper') server.args.push('--wrapper');
      if (variant === 'symlink directory') {
        const directory = join(f.oldRoot, 'packages/mcp-server/dist');
        rmSync(directory, { recursive: true });
        symlinkSync(join(f.newRoot, 'packages/mcp-server/dist'), directory);
      }
      if (variant === 'writer lock')
        writeFileSync(join(f.base, 'profile/.gemini/config/.cat-cafe-mcp-config.lock'), '');
      if (variant === 'remote URL') server.env.CAT_CAFE_API_URL = 'https://foreign.example';
      writeFileSync(f.configPath, JSON.stringify(f.prior));
      const before = readFileSync(f.configPath, 'utf8');
      assert.throws(f.run, /host-owned|active|symlink|repository|binding|EEXIST/i);
      assert.equal(readFileSync(f.configPath, 'utf8'), before);
    } finally {
      f.cleanup();
    }
  });
}
