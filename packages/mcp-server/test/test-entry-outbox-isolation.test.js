import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testCommand = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).scripts.test;
const nodeCommand = testCommand.slice(testCommand.indexOf('node ') + 'node '.length);
const entryImports = nodeCommand.slice(0, nodeCommand.indexOf('--test ')).trim().split(/\s+/);

for (const fixture of ['cross-post-message-targetcats.test.js', 'f247-cloud-collaboration-contract.test.js']) {
  for (const source of ['explicit directory', 'default HOME']) {
    test(`MCP test entry preserves ${source} callback outbox while running ${fixture}`, (t) => {
      const root = mkdtempSync(join(tmpdir(), 'cat-cafe-mcp-entry-test-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const home = join(root, 'home');
      const outbox =
        source === 'default HOME' ? join(home, '.cat-cafe', 'callback-outbox') : join(root, 'caller-outbox');
      mkdirSync(home);
      mkdirSync(outbox, { recursive: true });
      const entries = {
        '1000-foreign.json': JSON.stringify({
          id: 'foreign',
          queuedAt: 1000,
          apiUrl: 'http://127.0.0.1:1',
          path: '/api/callbacks/post-message',
          body: { content: 'caller-owned callback must survive' },
          headers: { 'x-invocation-id': 'foreign', 'x-callback-token': 'foreign' },
          attempts: 0,
          lastError: '',
        }),
        '1001-malformed.json': '{ caller-owned malformed entry',
      };
      for (const [name, body] of Object.entries(entries)) writeFileSync(join(outbox, name), body);
      const result = spawnSync(process.execPath, [...entryImports, '--test', `test/${fixture}`], {
        cwd: packageRoot,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          ...(source === 'explicit directory' ? { CAT_CAFE_CALLBACK_OUTBOX_DIR: outbox } : {}),
          CAT_CAFE_CALLBACK_OUTBOX_ENABLED: 'true',
        },
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.equal(result.status, 0, `${fixture}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
      assert.deepEqual(
        readdirSync(outbox).sort(),
        Object.keys(entries).sort(),
        'caller-owned entries must not be consumed',
      );
      for (const [name, body] of Object.entries(entries)) assert.equal(readFileSync(join(outbox, name), 'utf8'), body);
    });
  }
}

test('MCP test entry creates different outboxes for each process and cleans them on exit', () => {
  const paths = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync(
      process.execPath,
      [
        ...entryImports,
        '--input-type=module',
        '-e',
        'console.log(JSON.stringify({ directory: process.env.CAT_CAFE_CALLBACK_OUTBOX_DIR, enabled: process.env.CAT_CAFE_CALLBACK_OUTBOX_ENABLED }))',
      ],
      {
        cwd: packageRoot,
        env: { PATH: process.env.PATH },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const { directory, enabled } = JSON.parse(result.stdout);
    assert.equal(enabled, 'true', 'outbox transport remains enabled');
    assert.ok(directory, 'entrypoint must install a private outbox');
    assert.equal(existsSync(directory), false, 'private outbox must be removed after process exit');
    paths.push(directory);
  }
  assert.notEqual(paths[0], paths[1]);
});
