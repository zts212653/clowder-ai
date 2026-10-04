import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { materializeAgyNativeMcpConfig } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-mcp-config.js'
);

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'f325-agy-mcp-'));
  const home = join(base, 'profile');
  const runtimeRoot = join(base, 'runtime');
  const configDir = join(home, '.gemini', 'config');
  const dist = join(runtimeRoot, 'packages', 'mcp-server', 'dist');
  mkdirSync(configDir, { recursive: true });
  const credentialDir = join(configDir, 'cat-cafe-credentials');
  mkdirSync(credentialDir, { mode: 0o700 });
  const credentialFile = join(credentialDir, '00000000-0000-4000-8000-000000000001.json');
  writeFileSync(credentialFile, JSON.stringify({ invocationId: 'inv-1', callbackToken: 'secret-1' }), { mode: 0o600 });
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'collab.js'), '// host-owned fixture\n');
  writeFileSync(join(dist, 'memory.js'), '// host-owned fixture\n');
  const configPath = join(configDir, 'mcp_config.json');
  return {
    base,
    home,
    runtimeRoot,
    dist,
    configPath,
    credentialFile,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

describe('F325 host-owned AGY MCP config', () => {
  test('replaces the official CLI zero-byte MCP placeholder with a host-owned config', () => {
    const f = fixture();
    try {
      writeFileSync(f.configPath, '');
      const path = materializeAgyNativeMcpConfig({
        profileHome: f.home,
        runtimeRoot: f.runtimeRoot,
        serverNames: ['cat-cafe-collab'],
        callback: { apiUrl: 'http://127.0.0.1:3012', credentialFile: f.credentialFile },
      });
      assert.equal(path, realpathSync(f.configPath));
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      assert.deepEqual(Object.keys(parsed.mcpServers), ['cat-cafe-collab']);
      assert.equal(parsed.mcpServers['cat-cafe-collab'].args[0], realpathSync(join(f.dist, 'collab.js')));
      assert.ok(!readFileSync(path, 'utf8').includes('secret-1'));
    } finally {
      f.cleanup();
    }
  });

  test('writes only resolved built-in entrypoints with no persisted callback token', () => {
    const f = fixture();
    try {
      const path = materializeAgyNativeMcpConfig({
        profileHome: f.home,
        runtimeRoot: f.runtimeRoot,
        serverNames: ['cat-cafe-collab', 'cat-cafe-memory'],
        callback: { apiUrl: 'http://127.0.0.1:3012', credentialFile: f.credentialFile },
      });
      assert.equal(path, realpathSync(f.configPath));
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ['cat-cafe-collab', 'cat-cafe-memory']);
      assert.deepEqual(parsed.mcpServers['cat-cafe-collab'], {
        command: realpathSync(process.execPath),
        args: [realpathSync(join(f.dist, 'collab.js'))],
        env: { CAT_CAFE_API_URL: 'http://127.0.0.1:3012', CAT_CAFE_CREDENTIAL_FILE: realpathSync(f.credentialFile) },
      });
      assert.ok(!readFileSync(path, 'utf8').includes('CAT_CAFE_CALLBACK_TOKEN'));
      assert.ok(!readFileSync(path, 'utf8').includes('secret-1'));
      assert.equal(
        materializeAgyNativeMcpConfig({
          profileHome: f.home,
          runtimeRoot: f.runtimeRoot,
          serverNames: ['cat-cafe-collab', 'cat-cafe-memory'],
          callback: { apiUrl: 'http://127.0.0.1:3012', credentialFile: f.credentialFile },
        }),
        path,
      );
    } finally {
      f.cleanup();
    }
  });

  test('refuses a pre-existing third-party server rather than overwriting it', () => {
    const f = fixture();
    try {
      const before = JSON.stringify({ mcpServers: { rogue: { command: '/bin/echo', args: [] } } });
      writeFileSync(f.configPath, before);
      assert.throws(
        () =>
          materializeAgyNativeMcpConfig({
            profileHome: f.home,
            runtimeRoot: f.runtimeRoot,
            serverNames: ['cat-cafe-collab'],
            callback: { apiUrl: 'http://127.0.0.1:3012', credentialFile: f.credentialFile },
          }),
        /untrusted|host-owned|MCP/i,
      );
      assert.equal(readFileSync(f.configPath, 'utf8'), before);
    } finally {
      f.cleanup();
    }
  });

  test('refuses non-empty malformed MCP config rather than treating it as a placeholder', () => {
    const f = fixture();
    try {
      writeFileSync(f.configPath, '{');
      assert.throws(
        () =>
          materializeAgyNativeMcpConfig({
            profileHome: f.home,
            runtimeRoot: f.runtimeRoot,
            serverNames: [],
          }),
        SyntaxError,
      );
      assert.equal(readFileSync(f.configPath, 'utf8'), '{');
    } finally {
      f.cleanup();
    }
  });

  test('permits a validated host-owned subset change, but refuses symlink entrypoints', () => {
    const f = fixture();
    try {
      materializeAgyNativeMcpConfig({
        profileHome: f.home,
        runtimeRoot: f.runtimeRoot,
        serverNames: ['cat-cafe-collab'],
        callback: { apiUrl: 'http://127.0.0.1:3012', credentialFile: f.credentialFile },
      });
      materializeAgyNativeMcpConfig({
        profileHome: f.home,
        runtimeRoot: f.runtimeRoot,
        serverNames: ['cat-cafe-memory'],
        callback: { apiUrl: 'http://127.0.0.1:3012', credentialFile: f.credentialFile },
      });
      const parsed = JSON.parse(readFileSync(f.configPath, 'utf8'));
      assert.deepEqual(Object.keys(parsed.mcpServers), ['cat-cafe-memory']);
      rmSync(join(f.dist, 'collab.js'));
      symlinkSync(join(f.dist, 'memory.js'), join(f.dist, 'collab.js'));
      assert.throws(
        () =>
          materializeAgyNativeMcpConfig({
            profileHome: f.home,
            runtimeRoot: f.runtimeRoot,
            serverNames: ['cat-cafe-collab'],
            callback: { apiUrl: 'http://127.0.0.1:3012', credentialFile: f.credentialFile },
          }),
        /symlink|host-owned/i,
      );
    } finally {
      f.cleanup();
    }
  });
});
