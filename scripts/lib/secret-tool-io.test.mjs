import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { redactSecretContent } from './secret-content-scan.mjs';
import { withSecretToolGuard } from './secret-tool-io.mjs';

const fake = () => ['ghp', '_', 'E'.repeat(36)].join('');
const roots = [];
const credentialEnvKeys = [
  'CAT_CAFE_CREDENTIAL_FILE',
  'CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE',
  'CAT_CAFE_MCP_CREDS_DIR',
  'CODEX_CREDENTIALS_PATH',
  'CLAUDE_CREDENTIALS_PATH',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'GEMINI_HOME',
  'KIMI_CODE_HOME',
  'DSH_HOME',
  'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME',
];
async function withCredentialEnv(values, run) {
  const saved = new Map(credentialEnvKeys.map((key) => [key, process.env[key]]));
  for (const key of credentialEnvKeys) delete process.env[key];
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MCP input/result boundary', () => {
  for (const [key, configured, filename] of [
    ['CAT_CAFE_CREDENTIAL_FILE', 'store/session.json', 'store/session.json'],
    ['CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE', 'store/session.json', 'store/session.json'],
    ['CAT_CAFE_MCP_CREDS_DIR', 'store', 'store/native-turn.json'],
    ['CODEX_HOME', 'provider', 'provider/auth.json'],
    ['CLAUDE_CONFIG_DIR', 'provider', 'provider/.credentials.json'],
    ['GEMINI_HOME', 'provider', 'provider/oauth_creds.json'],
    ['KIMI_CODE_HOME', 'provider', 'provider/config.toml'],
    ['DSH_HOME', 'provider', 'provider/.credentials.yaml'],
    ['GH_CONFIG_DIR', 'provider', 'provider/hosts.yml'],
    ['XDG_CONFIG_HOME', 'config-root', 'config-root/gh/hosts.yml'],
  ])
    it(`resolves configured ${key} at the same cwd as the read handler`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'credential-context-'));
      roots.push(root);
      const source = join(root, filename);
      mkdirSync(join(source, '..'), { recursive: true });
      writeFileSync(source, 'opaque fixture credential');
      symlinkSync(source, join(root, 'notes.txt'));
      for (const value of [configured, join(root, configured)])
        await withCredentialEnv({ [key]: value }, async () => {
          let calls = 0;
          const result = await withSecretToolGuard(
            'read_file',
            { path: 'notes.txt' },
            async () => {
              calls++;
              return {};
            },
            { cwd: root },
          );
          assert.equal(calls, 0);
          assert.equal(result.isError, true);
        });
    });

  it('rejects secret arguments before invoking a server, including read/search queries', async () => {
    let effects = 0;
    const result = await withSecretToolGuard('search', { query: fake() }, async () => {
      effects++;
      return {};
    });
    assert.equal(effects, 0);
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes(fake()));
  });

  it('blocks explicit credential file reads before the handler opens them', async () => {
    let opened = false;
    const result = await withSecretToolGuard('read_file', { path: '/work/.env.local' }, async () => {
      opened = true;
    });
    assert.equal(opened, false);
    assert.equal(result.isError, true);
  });

  it('blocks configured credential files through symlinks on either side of the comparison', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opaque-auth-file-'));
    roots.push(root);
    const source = join(root, 'session.json');
    const alias = join(root, 'ordinary-link.json');
    writeFileSync(source, JSON.stringify({ invocationId: 'fixture-turn', callbackToken: 'opaque-fixture-auth' }));
    symlinkSync(source, alias);
    for (const key of [
      'CAT_CAFE_CREDENTIAL_FILE',
      'CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE',
      'CODEX_CREDENTIALS_PATH',
      'CLAUDE_CREDENTIALS_PATH',
      'GOOGLE_APPLICATION_CREDENTIALS',
    ])
      for (const configured of [source, alias])
        await withCredentialEnv({ [key]: configured }, async () => {
          for (const path of [
            source,
            alias,
            pathToFileURL(alias).href,
            pathToFileURL(alias).href.replace('file:', 'FILE:'),
          ]) {
            let opened = false;
            const notices = [];
            const result = await withSecretToolGuard(
              'read_file',
              { path },
              async () => {
                opened = true;
                return { content: [{ type: 'text', text: readFileSync(source, 'utf8') }] };
              },
              { notify: async (notice) => notices.push(notice) },
            );
            assert.equal(opened, false);
            assert.equal(result.isError, true);
            assert.equal(notices.length, 0);
          }
        });
  });

  it('protects custom credential directories and provider homes by canonical identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opaque-auth-root-'));
    roots.push(root);
    const store = join(root, 'private-store');
    const alias = join(root, 'configured-store');
    mkdirSync(store);
    symlinkSync(store, alias);
    for (const [key, filename] of [
      ['CAT_CAFE_MCP_CREDS_DIR', 'native-turn.json'],
      ['KIMI_CODE_HOME', 'config.toml'],
      ['DSH_HOME', '.credentials.yaml'],
      ['CODEX_HOME', 'auth.json'],
      ['CLAUDE_CONFIG_DIR', '.credentials.json'],
      ['GEMINI_HOME', 'oauth_creds.json'],
    ]) {
      const source = join(store, filename);
      const fileAlias = join(root, 'ordinary-file.txt');
      writeFileSync(source, 'opaque-fixture-auth');
      symlinkSync(source, fileAlias);
      await withCredentialEnv({ [key]: alias }, async () => {
        for (const path of [source, join(alias, filename), fileAlias]) {
          let calls = 0;
          const result = await withSecretToolGuard('read_file', { path }, async () => {
            calls++;
            return {};
          });
          assert.equal(calls, 0);
          assert.equal(result.isError, true);
        }
        const neighbor = `${store}-public`;
        mkdirSync(neighbor, { recursive: true });
        const ordinary = join(neighbor, 'notes.txt');
        writeFileSync(ordinary, 'ordinary result');
        const result = await withSecretToolGuard('read_file', { path: ordinary }, async () => ({
          content: [{ type: 'text', text: readFileSync(ordinary, 'utf8') }],
        }));
        assert.equal(result.content[0].text, 'ordinary result');
      });
      rmSync(fileAlias);
    }
  });

  it('redacts a tool result and persists a source-only rotation notice', async () => {
    const notices = [];
    const result = await withSecretToolGuard(
      'read_text',
      {},
      async () => ({
        content: [{ type: 'text', text: `read result: ${fake()}` }],
        structuredContent: { value: fake() },
      }),
      {
        callId: 'opaque-call-1',
        notify: async (notice) => {
          notices.push(notice);
        },
      },
    );
    assert.ok(!JSON.stringify(result).includes(fake()));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].state, 'exposed_or_suspected');
    assert.ok(!JSON.stringify(notices).includes(fake()));
    assert.equal(result._meta.secretExposure.rotationNotice, 'recorded');
  });

  it('redacts an opaque callback credential from an unexpected result and records exposure', async () => {
    const callbackToken = ['Ab3Cd4Ef5Gh6', 'Ij7Kl8Mn9Pq0'].join('').repeat(2);
    const notices = [];
    const result = await withSecretToolGuard(
      'read_text',
      {},
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ callbackToken }) }],
        structuredContent: { callbackToken },
      }),
      { notify: async (notice) => notices.push(notice) },
    );
    assert.ok(!JSON.stringify(result).includes(callbackToken));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].state, 'exposed_or_suspected');
  });

  it('reports failed notice delivery honestly without revealing the result', async () => {
    const result = await withSecretToolGuard(
      'read_text',
      {},
      async () => ({ content: [{ type: 'text', text: fake() }] }),
      {
        notify: async () => {
          throw new Error('offline');
        },
      },
    );
    assert.ok(!JSON.stringify(result).includes(fake()));
    assert.equal(result._meta.secretExposure.rotationNotice, 'failed');
  });

  it('redacts complete variable-length credentials crossing result chunk boundaries', async () => {
    const values = [
      ['sk', '-ant-api03-', 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9Pq0'.repeat(4)].join(''),
      ['sk', '-proj-', 'B'.repeat(128)].join(''),
      `PASSWORD="${'Ab3Cd4Ef5Gh6Ij7Kl8Mn9Pq0'.repeat(4)}"`,
    ];
    for (const boundary of [1024 * 1024, 2 * 1024 * 1024])
      for (const value of values) {
        const prefix = `中文${'.'.repeat(boundary - 49 - Buffer.byteLength('中文'))}`;
        const suffix = '\nordinary result end';
        const notices = [];
        const result = await withSecretToolGuard(
          'read_text',
          {},
          async () => ({ content: [{ type: 'text', text: prefix + value + suffix }] }),
          {
            notify: async (notice) => {
              notices.push(notice);
            },
          },
        );
        assert.ok(
          result.content[0].text === prefix + redactSecretContent(value) + suffix,
          'chunking must not change redaction extent or ordinary UTF-8 bytes',
        );
        assert.equal(result._meta.secretExposure.rotationNotice, 'recorded');
        assert.equal(notices.length, 1);
      }
  });

  it('freezes upload files before the external tool runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-upload-'));
    roots.push(root);
    const path = join(root, 'note.txt');
    writeFileSync(path, fake());
    let calls = 0;
    const result = await withSecretToolGuard('browser_upload_file', { paths: [path] }, async () => {
      calls++;
      return {};
    });
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
    writeFileSync(path, 'clean note');
    const clean = await withSecretToolGuard('browser_upload_file', { paths: [path] }, async (input) => {
      writeFileSync(path, fake());
      assert.notEqual(input.paths[0], path);
      return { content: [{ type: 'text', text: readFileSync(input.paths[0], 'utf8') }] };
    });
    assert.equal(clean.content[0].text, 'clean note');
  });
});
