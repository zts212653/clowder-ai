import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { probeRuntimeCatalog } from '../src/routes/runtime-catalog-probe.js';

// Opt-in installed DSH protocol regression. No prompts or vendor requests.
test(
  'real DSH ACP advertises the inherited model and adopts its native effort',
  {
    skip: !process.env.DSH_NATIVE_CATALOG_TEST_ENTRY,
    timeout: 30000,
  },
  async (t) => {
    const entry = process.env.DSH_NATIVE_CATALOG_TEST_ENTRY;
    assert.ok(entry);
    const root = mkdtempSync(join(tmpdir(), 'native-dsh-catalog-'));
    const home = join(root, 'home');
    const project = join(root, 'project');
    mkdirSync(project);
    for (const profile of ['desktop', 'acp']) {
      const directory = join(home, 'profiles', profile);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          dsh: {
            profile: { bundles: ['@deepseek-ai/dsh-base', ...(profile === 'acp' ? ['@deepseek-ai/dsh-acp-app'] : [])] },
          },
        }),
      );
      writeFileSync(
        join(directory, 'cordis.patch.yml'),
        profile === 'desktop'
          ? '- id: llm-deepseek\n  config: { apiKeyEnv: FIXTURE_NATIVE_CATALOG_KEY }\n- id: agent-default-model\n  config: { provider: deepseek-official, model: deepseek-flash, reasoningEffort: max }\n'
          : '- id: acp\n  config: { provider: retired, model: retired, sessionListPageSize: 7 }\n',
      );
    }
    const previous = new Map(['DSH_HOME', 'FIXTURE_NATIVE_CATALOG_KEY'].map((key) => [key, process.env[key]]));
    process.env.DSH_HOME = home;
    process.env.FIXTURE_NATIVE_CATALOG_KEY = 'fixture-only-never-sent';
    t.after(() =>
      previous.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }),
    );
    const catalog = await probeRuntimeCatalog({
      kind: 'acp',
      command: process.execPath,
      args: [entry, '--profile', 'acp'],
      cwd: project,
    });
    assert.equal(catalog.status, 'live');
    assert.equal(catalog.defaultModel, '["deepseek-official","deepseek-flash"]');
    assert.equal(catalog.defaultEffort, 'max');
  },
);
