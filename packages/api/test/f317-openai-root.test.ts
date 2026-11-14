import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { readConfiguredPageAction } from '../src/domains/concierge/action/jev/page-action-config.js';
import { readHomeJevSelector } from '../src/domains/concierge/live/host/home/home-jev-config.js';
import { platformHttpTransport } from '../src/domains/services/openai-platform/http-transport.js';

for (const mode of ['direct', 'runtime'] as const) {
  test(`F317 ${mode} startup reads the Hub account from the workspace root when API cwd is packages/api`, async () => {
    const previousEnvironment = { ...process.env };
    const previousCwd = process.cwd();
    const root = mkdtempSync(join(tmpdir(), 'f317-openai-root-'));
    try {
      for (const key of [
        'CAT_CAFE_GLOBAL_CONFIG_ROOT',
        'CAT_CAFE_RUNTIME_ROOT',
        'CAT_CAFE_WORKSPACE_ROOT',
        'CAT_CAFE_CONFIG_ROOT',
        'CAT_TEMPLATE_PATH',
      ])
        delete process.env[key];
      mkdirSync(join(root, 'packages/api'), { recursive: true });
      mkdirSync(join(root, '.cat-cafe'));
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
      writeFileSync(
        join(root, '.cat-cafe/accounts.json'),
        JSON.stringify({ platform: { clientId: 'openai', authType: 'api_key' } }),
      );
      writeFileSync(
        join(root, '.cat-cafe/credentials.json'),
        JSON.stringify({ platform: { apiKey: 'FAKE_ROOT_KEY' } }),
      );
      if (mode === 'runtime') {
        process.env.CAT_CAFE_RUNTIME_ROOT = root;
        process.env.CAT_CAFE_WORKSPACE_ROOT = root;
      }
      const path = join(root, 'page.json');
      writeFileSync(
        path,
        JSON.stringify({
          profileId: 'root-note',
          pageUrl: 'http://127.0.0.1:5261/',
          browserURL: 'http://127.0.0.1:5262',
          allowJevProjection: true,
          targets: [{ id: 'note', selector: '#note', operation: 'fill', expectedReadbackTemplate: '{value}' }],
          readback: { selector: '#note', kind: 'value' },
        }),
      );
      process.chdir(join(root, 'packages/api'));
      let calls = 0;
      mock.method(platformHttpTransport, 'fetch', async (url: string, init: RequestInit) => {
        calls++;
        assert.equal(url, 'https://api.openai.com/v1/decisions');
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer FAKE_ROOT_KEY');
        return Response.json({
          model: 'gpt-6-luna',
          answers: [
            { name: 'target', type: 'choice', choice: 'C0', confidence: 0.9 },
            { name: 'value', type: 'choice', choice: 'V0', confidence: 0.9 },
          ],
        });
      });
      const env = { CAT_CAFE_PAGE_DECISION_PROVIDER: 'openai', OPENAI_PLATFORM_ACCOUNT_REF: 'platform' };
      const candidates = [{ id: 'note', operation: 'fill' as const, label: '今日便签', fingerprint: 'local-only' }];
      const input = { utterance: '把今日便签改成带伞', signal: new AbortController().signal };
      const home = await readHomeJevSelector(env);
      assert.ok(home);
      assert.equal((await home.select({ ...input, candidates })).receipt.accountRef, 'platform');
      const configured = await readConfiguredPageAction({ ...env, CAT_CAFE_JEV_PAGE_CONFIG: path });
      assert.ok(configured && 'profile' in configured);
      const plan = await configured.profile.prepare(
        { url: 'http://127.0.0.1:5261/', origin: 'http://127.0.0.1:5261', readback: '', candidates },
        input,
      );
      assert.equal(plan.selection?.accountRef, 'platform');
      assert.equal(plan.action.expectedReadback, '带伞');
      assert.equal(calls, 2);
    } finally {
      mock.restoreAll();
      process.chdir(previousCwd);
      process.env = previousEnvironment;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
