import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(testDir, '..');
const wrapper = join(apiRoot, 'scripts/with-test-home.sh');
const rootSelectors = ['CAT_CAFE_GLOBAL_CONFIG_ROOT', 'CAT_CAFE_CONFIG_ROOT', 'CAT_TEMPLATE_PATH'];

test('with-test-home does not use inherited native Codex auth or SQLite homes', () => {
  const outerRoot = mkdtempSync(join(tmpdir(), 'native-home-sentinel-'));
  try {
    const identity = {
      'https://api.openai.com/auth': { chatgpt_user_id: 'sentinel-user', chatgpt_account_id: 'sentinel-workspace' },
    };
    writeFileSync(
      join(outerRoot, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: `x.${Buffer.from(JSON.stringify(identity)).toString('base64url')}.x`,
          account_id: 'sentinel-workspace',
        },
      }),
    );
    const probe = `
      const { resolveCodexAccountLaunch } = await import(process.argv[1]);
      const { inspectCodexLogin } = await import(process.argv[2]);
      const launch = resolveCodexAccountLaunch({ id:'codex', authType:'oauth' }, { cwd:process.argv[3] });
      console.log(JSON.stringify({
        nativeHome: launch.credentialHome === process.env.HOME + '/.codex',
        sqliteHome: launch.sqliteHome === launch.credentialHome,
        state: inspectCodexLogin(launch.credentialHome).status,
      }));
    `;
    const result = spawnSync(
      'bash',
      [
        wrapper,
        'node',
        '--input-type=module',
        '-e',
        probe,
        join(apiRoot, 'dist/config/codex-account-launch.js'),
        join(apiRoot, 'dist/config/codex-account-identity.js'),
        outerRoot,
      ],
      {
        cwd: apiRoot,
        env: { ...process.env, CODEX_HOME: outerRoot, CODEX_SQLITE_HOME: join(outerRoot, 'sqlite') },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { nativeHome: true, sqliteHome: true, state: 'not_logged_in' });
  } finally {
    rmSync(outerRoot, { recursive: true, force: true });
  }
});

for (const selector of rootSelectors) {
  test(`with-test-home prevents API credential writes through inherited ${selector}`, () => {
    const outerRoot = mkdtempSync(join(tmpdir(), 'api-account-root-sentinel-'));
    const configDir = join(outerRoot, '.cat-cafe');
    mkdirSync(configDir);
    const sentinels = {
      'accounts.json': JSON.stringify({ 'user-owned': { authType: 'api_key' } }),
      'credentials.json': JSON.stringify({ 'user-owned': { apiKey: 'sentinel-only' } }),
      'cat-catalog.json': JSON.stringify({ accounts: {}, breeds: [{ accountRef: 'user-owned' }] }),
    };
    try {
      for (const [name, content] of Object.entries(sentinels)) writeFileSync(join(configDir, name), content);
      const template = join(outerRoot, 'cat-template.json');
      writeFileSync(template, '{}');
      const outerEnv = { ...process.env };
      for (const rootSelector of rootSelectors) delete outerEnv[rootSelector];
      outerEnv[selector] = selector === 'CAT_TEMPLATE_PATH' ? template : outerRoot;
      const probe = `
        const { resolveAccountProjectRoot } = await import(process.argv[1]);
        const { writeCredential } = await import(process.argv[2]);
        const root = await resolveAccountProjectRoot(undefined);
        try {
          writeCredential('test-write-probe', { apiKey: 'isolated-fixture' }, root);
          console.log('write-allowed');
        } catch (error) {
          if (!String(error.message).includes('[test sandbox]')) throw error;
          console.log('write-blocked');
        }
      `;
      const result = spawnSync(
        'bash',
        [
          wrapper,
          'node',
          '--input-type=module',
          '-e',
          probe,
          join(apiRoot, 'dist/routes/accounts-project-root.js'),
          join(apiRoot, 'dist/config/credentials.js'),
        ],
        { cwd: apiRoot, env: outerEnv, encoding: 'utf8' },
      );
      for (const [name, content] of Object.entries(sentinels)) {
        assert.equal(
          readFileSync(join(configDir, name), 'utf8'),
          content,
          `external ${name} must remain byte-identical`,
        );
      }
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'write-blocked', 'the default checkout root must retain its write guard');
    } finally {
      rmSync(outerRoot, { recursive: true, force: true });
    }
  });
}
